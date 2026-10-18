import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOf, queuedOrder, setup, startFakeSimulator } from './helpers.js';

let ctx;
let sim;
before(async () => {
  sim = await startFakeSimulator();
  ctx = await setup({ simulatorUrl: sim.url, heartbeatTimeoutMs: 15000, delayedGraceMs: 60000, maxDispatchAttempts: 2 });
});
beforeEach(async () => {
  await ctx.db.query('TRUNCATE order_events, orders, audit_logs, oxide_bot_commands RESTART IDENTITY CASCADE');
  await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'online', last_heartbeat = now(), updated_at = now()`);
  sim.state.bots.clear();
  sim.addBot('bot-01');
  sim.addBot('bot-02');
});
after(async () => { await sim.close(); await ctx.db.close(); });

const botStatus = async (id) => (await ctx.db.query('SELECT status FROM oxide_bot_agents WHERE id = $1', [id])).rows[0].status;

// ---------- เคส 3: บอทหลุดกลางงาน ----------
test('heartbeat หมดเวลา → บอท error + ออเดอร์ที่บอทนั้นถืออยู่เป็น DELAYED (ออเดอร์ของบอทที่ปกติไม่ถูกแตะ)', async () => {
  const a = await queuedOrder(ctx, 'ORD-A');
  const b = await queuedOrder(ctx, 'ORD-B');
  const oa = (await ctx.orders.dispatch(a)).order;
  const ob = (await ctx.orders.dispatch(b)).order;
  assert.notEqual(oa.botId, ob.botId);

  await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '30 seconds' WHERE id = $1`, [oa.botId]);
  const r = await ctx.monitor.sweepOnce();

  assert.equal(r.lostBots, 1);
  assert.equal(await botStatus(oa.botId), 'error');
  assert.equal(await botStatus(ob.botId), 'online');
  assert.equal((await ctx.orders.getOrder(a)).state, 'DELAYED');
  assert.equal((await ctx.orders.getOrder(b)).state, 'IN_PROGRESS');
  const lostLog = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'bot.heartbeat_lost' AND target_id = $1`, [oa.botId]);
  assert.equal(lostLog.rowCount, 1);
});

test('sweep ซ้ำหลายรอบ → ไม่เขียน event ซ้ำ (idempotent)', async () => {
  const id = await queuedOrder(ctx, 'ORD-IDEM');
  const { order } = await ctx.orders.dispatch(id);
  await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '30 seconds' WHERE id = $1`, [order.botId]);
  await Promise.all([ctx.monitor.sweepOnce(), ctx.monitor.sweepOnce(), ctx.monitor.sweepOnce()]);
  await ctx.monitor.sweepOnce();
  assert.equal((await eventsOf(ctx, id)).filter((p) => p.to === 'DELAYED').length, 1);
});

test('DELAYED เกิน grace และยังมีโควตา → กลับ QUEUED แล้วจ่ายให้บอทเครื่องอื่น', async () => {
  const id = await queuedOrder(ctx, 'ORD-RETRY');
  const first = (await ctx.orders.dispatch(id)).order;
  await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '30 seconds' WHERE id = $1`, [first.botId]);
  await ctx.monitor.sweepOnce();
  assert.equal((await ctx.orders.getOrder(id)).state, 'DELAYED');

  // ยังไม่ถึงเวลา grace → ไม่เปลี่ยน
  assert.equal(await ctx.orders.resolveExpiredDelayed(), 0);

  await ctx.db.query(
    `UPDATE order_events SET created_at = now() - interval '120 seconds' WHERE order_id = $1 AND payload->>'to' = 'DELAYED'`, [id]);
  assert.equal(await ctx.orders.resolveExpiredDelayed(), 1);
  assert.equal((await ctx.orders.getOrder(id)).state, 'QUEUED');

  const second = (await ctx.orders.dispatch(id)).order; // บอทตัวที่หลุดเป็น error จึงต้องไปบอทอีกเครื่อง
  assert.equal(second.state, 'IN_PROGRESS');
  assert.notEqual(second.botId, first.botId);
  assert.equal((await eventsOf(ctx, id)).filter((p) => p.to === 'IN_PROGRESS').at(-1).attempt, 2);
});

test('DELAYED เกิน grace และครบโควตา retry → FAILED', async () => {
  const id = await queuedOrder(ctx, 'ORD-FAIL');
  for (let round = 1; round <= 2; round++) {
    const { order } = await ctx.orders.dispatch(id);
    await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'online', last_heartbeat = now() WHERE id <> $1`, [order.botId]);
    await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '30 seconds' WHERE id = $1`, [order.botId]);
    await ctx.monitor.sweepOnce();
    await ctx.db.query(
      `UPDATE order_events SET created_at = now() - interval '120 seconds' WHERE order_id = $1 AND payload->>'to' = 'DELAYED'`, [id]);
    await ctx.orders.resolveExpiredDelayed();
    if (round === 1) {
      assert.equal((await ctx.orders.getOrder(id)).state, 'QUEUED');
      await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'online', last_heartbeat = now()`);
    }
  }
  const final = await ctx.orders.getOrder(id);
  assert.equal(final.state, 'FAILED');
  assert.equal(final.status, 'failed');
});

test('บอทเดิมกลับมารายงานว่าเสร็จระหว่าง DELAYED → COMPLETED ได้ (บอทอื่นรายงานไม่ได้)', async () => {
  const id = await queuedOrder(ctx, 'ORD-LATE');
  const { order } = await ctx.orders.dispatch(id);
  await ctx.orders.markDelayed(id, 'heartbeat_timeout');
  const other = order.botId === 'bot-01' ? 'bot-02' : 'bot-01';
  await assert.rejects(ctx.orders.transition(id, 'COMPLETED', { botId: other }), { code: 'wrong_bot' });
  assert.equal((await ctx.orders.transition(id, 'COMPLETED', { botId: order.botId })).order.state, 'COMPLETED');
});

test('บอทไม่มีงานที่ถืออยู่ ไม่ได้รับงานใหม่ถ้า heartbeat เก่าเกินเวลา', async () => {
  const id = await queuedOrder(ctx, 'ORD-STALE');
  await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '60 seconds'`);
  await assert.rejects(ctx.orders.dispatch(id), { code: 'no_bot_available' });
});

// ---------- poll จาก simulator ----------
test('pollBots: บันทึกสถานะ+heartbeat จาก simulator, บอท offline ไม่ได้ต่ออายุ heartbeat', async () => {
  sim.addBot('bot-03', 'offline');
  await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '5 seconds' WHERE id = 'bot-01'`);
  const r = await ctx.monitor.pollBots();
  assert.equal(r.ok, true);
  const { rows } = await ctx.db.query(`SELECT id, status, last_heartbeat > now() - interval '2 seconds' AS fresh FROM oxide_bot_agents ORDER BY id`);
  assert.equal(rows.find((x) => x.id === 'bot-01').fresh, true);
  const b3 = rows.find((x) => x.id === 'bot-03');
  assert.equal(b3.status, 'offline');
  assert.equal(b3.fresh, null);
});

test('simulator ล่ม → pollBots ไม่ทำให้ระบบพัง และไม่ต่ออายุ heartbeat', async () => {
  const down = await setup({ simulatorUrl: 'http://127.0.0.1:1' });
  const before = (await down.db.query(`SELECT last_heartbeat FROM oxide_bot_agents WHERE id = 'bot-01'`)).rows[0].last_heartbeat;
  const r = await down.monitor.pollBots();
  assert.equal(r.ok, false);
  const after = (await down.db.query(`SELECT last_heartbeat FROM oxide_bot_agents WHERE id = 'bot-01'`)).rows[0].last_heartbeat;
  assert.equal(String(after), String(before));
  await down.db.close();
});
