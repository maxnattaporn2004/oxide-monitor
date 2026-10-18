import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startApi, startFakeSimulator } from './helpers.js';

let ctx;
let sim;
let api;
before(async () => {
  sim = await startFakeSimulator();
  ctx = await setup({ simulatorUrl: sim.url });
  api = await startApi(ctx);
});
beforeEach(async () => {
  await ctx.db.query('TRUNCATE order_events, orders, audit_logs, oxide_bot_commands RESTART IDENTITY CASCADE');
  await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'online', last_heartbeat = now()`);
  sim.state.failNext = 0;
  sim.state.bots.clear();
  sim.addBot('bot-01');
  sim.addBot('bot-02');
});
after(async () => { await api.close(); await sim.close(); await ctx.db.close(); });

test('GET /health', async () => {
  const r = await api.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('วงจรออเดอร์ครบผ่าน HTTP: สร้าง → จ่ายเงิน → จ่ายงาน → เสร็จ + timeline', async () => {
  const created = await api.call('POST', '/orders', { externalOrderId: 'API-1', amount: 250 });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, 'PENDING_PAYMENT');

  const again = await api.call('POST', '/orders', { externalOrderId: 'API-1', amount: 250 });
  assert.equal(again.status, 200, 'ส่งซ้ำต้องได้ 200 และออเดอร์เดิม');
  assert.equal(again.body.id, created.body.id);

  assert.equal((await api.call('POST', '/orders/API-1/dispatch')).status, 409, 'ยังไม่จ่ายเงิน จ่ายงานไม่ได้');
  assert.equal((await api.call('POST', '/orders/API-1/pay')).body.order.state, 'QUEUED');
  const dispatched = await api.call('POST', '/orders/API-1/dispatch');
  assert.equal(dispatched.body.order.state, 'IN_PROGRESS');
  const botId = dispatched.body.order.botId;

  const done = await api.call('POST', '/orders/API-1/transition', { to: 'COMPLETED', botId });
  assert.equal(done.body.order.state, 'COMPLETED');

  const timeline = await api.call('GET', '/orders/API-1/timeline');
  assert.deepEqual(timeline.body.map((e) => e.payload.to), ['PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'COMPLETED']);
});

test('ตรวจ error code: transition ผิด 409, ไม่พบ 404, JSON พัง 400, ไป IN_PROGRESS ตรงๆ 400', async () => {
  await api.call('POST', '/orders', { externalOrderId: 'API-2', amount: 1 });
  assert.equal((await api.call('POST', '/orders/API-2/transition', { to: 'COMPLETED' })).status, 409);
  assert.equal((await api.call('POST', '/orders/API-2/transition', { to: 'IN_PROGRESS' })).status, 400);
  assert.equal((await api.call('POST', '/orders/API-2/transition', { to: 'NOPE' })).status, 400);
  assert.equal((await api.call('GET', '/orders/does-not-exist')).status, 404);
  const bad = await fetch(`${api.base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('Kill-switch ผ่าน HTTP: ปิดแล้ว /dispatch ได้ 423', async () => {
  await api.call('POST', '/orders', { externalOrderId: 'API-3', amount: 1 });
  await api.call('POST', '/orders/API-3/pay');
  assert.equal((await api.call('PUT', '/system/kill-switch', { enabled: 'no' })).status, 400);
  assert.equal((await api.call('PUT', '/system/kill-switch', { enabled: false })).body.enabled, false);
  assert.equal((await api.call('POST', '/orders/API-3/dispatch')).status, 423);
  assert.equal((await api.call('GET', '/system/kill-switch')).body.enabled, false);
  await api.call('PUT', '/system/kill-switch', { enabled: true });
  assert.equal((await api.call('POST', '/orders/API-3/dispatch')).status, 200);
});

test('POST /bots/:id/commands: 201, replay ด้วย Idempotency-Key ได้ 200 + header, บอทไม่มี 404, คำสั่งผิด 400', async () => {
  const first = await api.call('POST', '/bots/bot-01/commands', { command: 'status' }, { 'idempotency-key': 'http-1' });
  assert.equal(first.status, 201);
  const second = await api.call('POST', '/bots/bot-01/commands', { command: 'status' }, { 'idempotency-key': 'http-1' });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.equal(second.body.id, first.body.id);
  assert.equal((await api.call('POST', '/bots/zzz/commands', { command: 'status' })).status, 404);
  assert.equal((await api.call('POST', '/bots/bot-01/commands', { command: 'dance' })).status, 400);
});

test('คำสั่งที่ปลายทางล้มเหลว → 502 พร้อมรายละเอียดใน body', async () => {
  sim.state.failNext = 100;
  const r = await api.call('POST', '/bots/bot-01/commands', { command: 'restart' });
  assert.equal(r.status, 502);
  assert.equal(r.body.status, 'failed');
});

test('GET /summary และ /overview: ตัวเลข Online / Active / Standby / In Progress ถูกต้อง', async () => {
  await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'offline' WHERE id = 'bot-02'`);
  await ctx.db.query(`INSERT INTO oxide_bot_agents (id, name, device_name, status, last_heartbeat) VALUES ('bot-03','B3','d3','online', now())`);
  await api.call('POST', '/orders', { externalOrderId: 'API-4', amount: 1 });
  await api.call('POST', '/orders/API-4/pay');
  await api.call('POST', '/orders/API-4/dispatch');

  const s = (await api.call('GET', '/summary')).body;
  assert.equal(s.onlineCount, 2);
  assert.equal(s.activeCount, 2);
  assert.equal(s.standbyCount, 1);
  assert.equal(s.inProgressCount, 1);

  await api.call('PUT', '/system/kill-switch', { enabled: false });
  const off = (await api.call('GET', '/summary')).body;
  assert.equal(off.activeCount, 0);
  assert.equal(off.standbyCount, 0);

  const ov = (await api.call('GET', '/overview')).body;
  assert.equal(ov.bots.length, 3);
  assert.ok(ov.bots.find((b) => b.id === 'bot-02').botState === 'offline');
  assert.ok(ov.orders.some((o) => o.externalOrderId === 'API-4'));
});

test('GET /bots/:id: มี metrics, ประวัติคำสั่ง และออเดอร์ล่าสุด', async () => {
  await api.call('POST', '/bots/bot-01/commands', { command: 'status' });
  const r = await api.call('GET', '/bots/bot-01');
  assert.equal(r.status, 200);
  assert.equal(r.body.commands.length, 1);
  assert.equal(typeof r.body.cpuPercent, 'number');
  assert.equal((await api.call('GET', '/bots/none')).status, 404);
});

test('POST /deployments และ GET /audit-logs', async () => {
  const d = await api.call('POST', '/deployments', { packageName: 'pkg.zip', botIds: ['bot-01'] });
  assert.equal(d.status, 200);
  assert.equal(d.body.results[0].outcome, 'updated');
  assert.equal((await api.call('POST', '/deployments', {})).status, 400);
  const logs = await api.call('GET', '/audit-logs?limit=10');
  assert.ok(logs.body.some((l) => l.action === 'deployment.requested'));
});
