import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startFakeSimulator } from './helpers.js';

let ctx;
let sim;
before(async () => {
  sim = await startFakeSimulator();
  ctx = await setup({ simulatorUrl: sim.url, commandRetries: 3, retryBaseMs: 5 });
});
beforeEach(async () => {
  await ctx.db.query('TRUNCATE oxide_bot_commands, audit_logs RESTART IDENTITY CASCADE');
  await ctx.db.query(`DELETE FROM oxide_bot_agents WHERE id NOT IN ('bot-01', 'bot-02')`); // บอทที่เทสต์ก่อนหน้าเพิ่มไว้
  await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'online', last_heartbeat = now()`);
  sim.state.failNext = 0;
  sim.state.failStatus = 500;
  sim.state.commandCalls = 0;
  sim.state.bots.clear();
  sim.addBot('bot-01', 'offline');
  sim.addBot('bot-02');
});
after(async () => { await sim.close(); await ctx.db.close(); });

const cmdRows = async () => (await ctx.db.query('SELECT * FROM oxide_bot_commands ORDER BY id')).rows;

test('คำสั่งปกติ: success, อัปเดตสถานะบอทใน DB, บันทึก audit log', async () => {
  const { command } = await ctx.commands.request('bot-01', 'start', { actor: 'tester' });
  assert.equal(command.status, 'success');
  assert.equal(command.result.attempts, 1);
  assert.equal((await ctx.db.query(`SELECT status FROM oxide_bot_agents WHERE id = 'bot-01'`)).rows[0].status, 'online');
  const actions = (await ctx.db.query('SELECT action FROM audit_logs ORDER BY id')).rows.map((r) => r.action);
  assert.deepEqual(actions, ['command.requested', 'command.success']);
});

// ---------- เคส 4: ปลายทางล้มเหลวชั่วคราว (retry) ----------
test('simulator ล้ม 2 ครั้งแรก (500) → retry แล้วสำเร็จ ครั้งที่ 3', async () => {
  sim.state.failNext = 2;
  const { command } = await ctx.commands.request('bot-01', 'restart');
  assert.equal(command.status, 'success');
  assert.equal(command.result.attempts, 3);
  assert.equal(sim.state.commandCalls, 3);
});

test('ล้มเหลวต่อเนื่องเกินโควตา retry → failed พร้อมเหตุผลและจำนวนครั้งที่ลอง', async () => {
  sim.state.failNext = 100;
  const { command } = await ctx.commands.request('bot-01', 'restart');
  assert.equal(command.status, 'failed');
  assert.equal(command.result.attempts, 4); // 1 ครั้งแรก + retry 3 ครั้ง
  assert.equal(command.result.error, 'boom');
  assert.equal(sim.state.commandCalls, 4);
  assert.ok(command.completedAt);
});

test('ข้อผิดพลาดแบบ 4xx (เช่น บอทไม่มีใน simulator) → ไม่ retry', async () => {
  await ctx.db.query(`INSERT INTO oxide_bot_agents (id, name, device_name) VALUES ('ghost', 'Ghost', 'nowhere')`);
  const { command } = await ctx.commands.request('ghost', 'status');
  assert.equal(command.status, 'failed');
  assert.equal(command.result.error, 'bot_not_found');
  assert.equal(command.result.attempts, 1);
  assert.equal(sim.state.commandCalls, 1);
});

test('บอทที่ไม่มีในระบบ → 404, command ไม่ถูกต้อง → 400', async () => {
  await assert.rejects(ctx.commands.request('nope', 'start'), { status: 404 });
  await assert.rejects(ctx.commands.request('bot-01', 'explode'), { status: 400, code: 'invalid_command' });
});

// ---------- Idempotency-Key ----------
test('Idempotency-Key เดิมส่งซ้ำ → ได้คำสั่งเดิม ยิงไปบอทครั้งเดียว', async () => {
  const first = await ctx.commands.request('bot-01', 'start', { idempotencyKey: 'key-1' });
  const second = await ctx.commands.request('bot-01', 'start', { idempotencyKey: 'key-1' });
  assert.equal(second.replayed, true);
  assert.equal(second.command.id, first.command.id);
  assert.equal(sim.state.commandCalls, 1);
  assert.equal((await cmdRows()).length, 1);
});

test('Idempotency-Key เดียวกัน 15 คำขอพร้อมกัน → สร้างคำสั่งเดียว ยิงบอทครั้งเดียว', async () => {
  const results = await Promise.all(
    Array.from({ length: 15 }, () => ctx.commands.request('bot-01', 'restart', { idempotencyKey: 'burst' }))
  );
  assert.equal(new Set(results.map((r) => r.command.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal((await cmdRows()).length, 1);
  assert.equal(sim.state.commandCalls, 1);
});

test('Idempotency-Key เดิมแต่คนละคำสั่ง → 409; key เดียวกันคนละบอทถือเป็นคนละคำขอ', async () => {
  await ctx.commands.request('bot-02', 'status', { idempotencyKey: 'k' });
  await assert.rejects(ctx.commands.request('bot-02', 'stop', { idempotencyKey: 'k' }), { code: 'idempotency_key_reused' });
  const other = await ctx.commands.request('bot-01', 'status', { idempotencyKey: 'k' });
  assert.equal(other.replayed, false);
});

test('ไม่ส่ง key: คำสั่งเหมือนกันสองครั้งถือเป็นสองคำสั่ง (ผู้ใช้ตั้งใจสั่งซ้ำได้)', async () => {
  await ctx.commands.request('bot-02', 'status');
  await ctx.commands.request('bot-02', 'status');
  assert.equal((await cmdRows()).length, 2);
});

// ---------- claim แบบ atomic + กู้คืนคำสั่งค้าง ----------
test('process คำสั่งเดียวกันพร้อมกัน → มีผู้ประมวลผลคนเดียว', async () => {
  const { rows } = await ctx.db.query(
    `INSERT INTO oxide_bot_commands (bot_id, command, requested_by) VALUES ('bot-02', 'status', 'test') RETURNING id`);
  const results = await Promise.all(Array.from({ length: 6 }, () => ctx.commands.process(rows[0].id)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(sim.state.commandCalls, 1);
});

test('sweep: คำสั่งที่ค้าง queued/running นานเกินเกณฑ์ถูกกู้คืนและประมวลผลจนจบ', async () => {
  await ctx.db.query(
    `INSERT INTO oxide_bot_commands (bot_id, command, requested_by, status, created_at) VALUES
       ('bot-02', 'status', 'test', 'queued',  now() - interval '1 minute'),
       ('bot-02', 'status', 'test', 'running', now() - interval '1 minute'),
       ('bot-02', 'status', 'test', 'queued',  now())`
  );
  assert.equal(await ctx.commands.sweep(), 2);
  const statuses = (await cmdRows()).map((r) => r.status);
  assert.deepEqual(statuses, ['success', 'success', 'queued']); // อันที่เพิ่งสร้างยังไม่ถึงเกณฑ์ ไม่ถูกแย่งไป
});

// ---------- Deployment (จำลอง) ----------
test('deployment ทุกเครื่อง: ข้ามบอทที่ไม่ online, สั่ง restart บอท online, บันทึก audit', async () => {
  await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'offline' WHERE id = 'bot-01'`);
  const out = await ctx.deployments.deploy({ packageName: 'oxide-2026-10-18.zip' });
  assert.equal(out.simulated, true);
  assert.deepEqual(out.results.map((r) => [r.botId, r.outcome]), [['bot-01', 'skipped'], ['bot-02', 'updated']]);
  const logs = await ctx.db.query(`SELECT target_id FROM audit_logs WHERE action = 'deployment.requested'`);
  assert.deepEqual(logs.rows.map((r) => r.target_id), ['bot-02']);
});

test('deployment ระบุรายเครื่อง / บอทไม่มีอยู่ / ไม่ใส่ชื่อแพ็กเกจ → 400', async () => {
  await assert.rejects(ctx.deployments.deploy({ packageName: 'x.zip', botIds: ['nope'] }), { status: 400 });
  await assert.rejects(ctx.deployments.deploy({ packageName: '' }), { status: 400 });
  const out = await ctx.deployments.deploy({ packageName: 'x.zip', botIds: ['bot-02'] });
  assert.equal(out.results.length, 1);
});
