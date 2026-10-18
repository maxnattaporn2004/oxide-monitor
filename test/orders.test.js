import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOf, queuedOrder, setup } from './helpers.js';

let ctx;
before(async () => { ctx = await setup(); });
beforeEach(async () => {
  await ctx.db.query('TRUNCATE order_events, orders, audit_logs RESTART IDENTITY CASCADE');
  await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'online', last_heartbeat = now()`);
});
after(() => ctx.db.close());

const settle = (promises) => Promise.allSettled(promises);

// ---------- เคส 1: สร้างออเดอร์ซ้ำพร้อมกัน (idempotency) ----------
test('สร้างออเดอร์ด้วย external id เดียวกัน 20 คำขอพร้อมกัน → ได้ 1 ออเดอร์ 1 event', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => ctx.orders.createOrder({ externalOrderId: 'ORD-DUP', amount: 500 }))
  );
  assert.equal(results.filter((r) => r.created).length, 1, 'ต้องมีแค่หนึ่งคำขอที่สร้างจริง');
  assert.equal(new Set(results.map((r) => r.order.id)).size, 1, 'ทุกคำขอต้องได้ออเดอร์เดียวกัน');
  const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE external_order_id = 'ORD-DUP'`);
  assert.equal(rows[0].n, 1);
  assert.equal((await eventsOf(ctx, results[0].order.id)).length, 1);
});

test('external id เดิมแต่ amount ต่างกัน → 409 idempotency_mismatch (ไม่เงียบ)', async () => {
  await ctx.orders.createOrder({ externalOrderId: 'ORD-X', amount: 100 });
  await assert.rejects(ctx.orders.createOrder({ externalOrderId: 'ORD-X', amount: 999 }), { code: 'idempotency_mismatch', status: 409 });
});

test('ตรวจ input: amount ติดลบ / currency ผิดรูปแบบ → 400', async () => {
  await assert.rejects(ctx.orders.createOrder({ externalOrderId: 'A', amount: -1 }), { status: 400 });
  await assert.rejects(ctx.orders.createOrder({ externalOrderId: 'A', amount: 1, currency: 'baht' }), { status: 400 });
  await assert.rejects(ctx.orders.createOrder({ externalOrderId: '', amount: 1 }), { status: 400 });
});

// ---------- เคส 2: กดจ่ายงานซ้ำพร้อมกัน (concurrency) ----------
test('จ่ายงานออเดอร์เดียว 10 คำขอพร้อมกัน → เข้า IN_PROGRESS ครั้งเดียว บอทเดียว', async () => {
  const id = await queuedOrder(ctx, 'ORD-RACE');
  const results = await settle(Array.from({ length: 10 }, () => ctx.orders.dispatch(id, { actor: 'test' })));
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'คำขอซ้ำต้องไม่ error (idempotent)');
  assert.equal(results.filter((r) => r.value.changed).length, 1, 'ต้องมีคำขอเดียวที่จ่ายจริง');
  const dispatches = (await eventsOf(ctx, id)).filter((p) => p.to === 'IN_PROGRESS');
  assert.equal(dispatches.length, 1);
  assert.equal(new Set(results.map((r) => r.value.order.botId)).size, 1);
});

test('บอทไม่รับเกิน capacity: 5 ออเดอร์พร้อมกัน / 2 บอท (รับได้เครื่องละ 1) → จ่ายสำเร็จ 2', async () => {
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push(await queuedOrder(ctx, `ORD-CAP-${i}`));
  const results = await settle(ids.map((id) => ctx.orders.dispatch(id, { actor: 'test' })));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 2);
  assert.ok(rejected.every((r) => r.reason.code === 'no_bot_available'));
  assert.equal(new Set(ok.map((r) => r.value.order.botId)).size, 2, 'สองงานต้องไปคนละบอท');
});

test('dispatchQueued สองตัวทำงานพร้อมกัน → ไม่จ่ายซ้ำ (SKIP LOCKED)', async () => {
  for (let i = 1; i <= 2; i++) await queuedOrder(ctx, `ORD-Q-${i}`);
  const [a, b] = await Promise.all([ctx.orders.dispatchQueued(), ctx.orders.dispatchQueued()]);
  assert.equal(a + b, 2);
  const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM order_events WHERE payload->>'to' = 'IN_PROGRESS'`);
  assert.equal(rows[0].n, 2);
});

test('คำสั่งที่ขัดกันพร้อมกัน (COMPLETED vs CANCELLED) → ชนะฝ่ายเดียว สถานะสุดท้ายสอดคล้องกับ event', async () => {
  const id = await queuedOrder(ctx, 'ORD-CONFLICT');
  await ctx.orders.dispatch(id, { actor: 'test' });
  const results = await settle([
    ctx.orders.transition(id, 'COMPLETED', { actor: 'bot' }),
    ctx.orders.transition(id, 'CANCELLED', { actor: 'admin' })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'invalid_transition');
  const final = await ctx.orders.getOrder(id);
  assert.ok(['COMPLETED', 'CANCELLED'].includes(final.state));
  const terminal = (await eventsOf(ctx, id)).filter((p) => ['COMPLETED', 'CANCELLED'].includes(p.to));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].to, final.state);
});

// ---------- state machine ผ่าน service ----------
test('เปลี่ยนไปสถานะเดิมซ้ำ → no-op ไม่เขียน event ซ้ำ', async () => {
  const id = await queuedOrder(ctx, 'ORD-NOOP');
  const again = await ctx.orders.transition(id, 'QUEUED', { actor: 'test' });
  assert.equal(again.changed, false);
  assert.equal((await eventsOf(ctx, id)).filter((p) => p.to === 'QUEUED').length, 1);
});

test('ข้ามขั้น / ย้อนจาก state ปลายทาง → 409 invalid_transition', async () => {
  const { order } = await ctx.orders.createOrder({ externalOrderId: 'ORD-SKIP', amount: 1 });
  await assert.rejects(ctx.orders.transition(order.id, 'COMPLETED'), { code: 'invalid_transition' });
  await ctx.orders.transition(order.id, 'CANCELLED');
  await assert.rejects(ctx.orders.transition(order.id, 'QUEUED'), { code: 'invalid_transition' });
});

test('expectedFrom ไม่ตรง → 409 state_conflict (compare-and-set)', async () => {
  const id = await queuedOrder(ctx, 'ORD-CAS');
  await assert.rejects(ctx.orders.transition(id, 'CANCELLED', { expectedFrom: 'PENDING_PAYMENT' }), { code: 'state_conflict' });
});

test('บอทที่ไม่ได้รับงานมารายงานผล → 409 wrong_bot', async () => {
  const id = await queuedOrder(ctx, 'ORD-WRONGBOT');
  const { order } = await ctx.orders.dispatch(id, { actor: 'test' });
  const other = order.botId === 'bot-01' ? 'bot-02' : 'bot-01';
  await assert.rejects(ctx.orders.transition(id, 'COMPLETED', { botId: other }), { code: 'wrong_bot' });
  const ok = await ctx.orders.transition(id, 'COMPLETED', { botId: order.botId });
  assert.equal(ok.order.state, 'COMPLETED');
  assert.equal(ok.order.botId, order.botId);
});

test('ข้อมูล seed ที่ไม่มี event: pending → PENDING_PAYMENT, processing → IN_PROGRESS', async () => {
  await ctx.db.query(`INSERT INTO orders (external_order_id, status, amount) VALUES ('SEED-1','pending',1),('SEED-2','processing',2)`);
  const list = await ctx.orders.listOrders();
  assert.equal(list.find((o) => o.externalOrderId === 'SEED-1').state, 'PENDING_PAYMENT');
  assert.equal(list.find((o) => o.externalOrderId === 'SEED-2').state, 'IN_PROGRESS');
});

// ---------- Kill-switch ----------
test('Kill-switch ปิด → จ่ายงานไม่ได้ (423) และ dispatchQueued ไม่จ่าย; เปิดแล้วจ่ายได้', async () => {
  const id = await queuedOrder(ctx, 'ORD-KILL');
  await ctx.killSwitch.set(false, 'test');
  await assert.rejects(ctx.orders.dispatch(id), { code: 'system_disabled', status: 423 });
  assert.equal(await ctx.orders.dispatchQueued(), 0);
  assert.equal((await ctx.orders.getOrder(id)).state, 'QUEUED');
  await ctx.killSwitch.set(true, 'test');
  assert.equal((await ctx.orders.dispatch(id)).order.state, 'IN_PROGRESS');
});

test('สลับ Kill-switch ซ้ำค่าเดิมพร้อมกัน → เขียน log ครั้งเดียว', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => ctx.killSwitch.set(false, 'test')));
  assert.equal(results.filter((r) => r.changed).length, 1);
  const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'kill_switch.set'`);
  assert.equal(rows[0].n, 1);
});
