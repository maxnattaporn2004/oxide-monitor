import { badRequest, conflict, notFound } from '../errors.js';
import { upsertBot } from './bots.js';

export const COMMANDS = ['start', 'stop', 'restart', 'status'];

const mapCommand = (r) => ({
  id: r.id, botId: r.bot_id, command: r.command, requestedBy: r.requested_by, status: r.status,
  result: r.result, createdAt: r.created_at, completedAt: r.completed_at
});

/**
 * คำสั่งควบคุมบอท: queued → running → success | failed
 *
 *  - Idempotency-Key: ส่งคำขอเดิมซ้ำ (เช่น ผู้ใช้กดสองครั้ง / client retry) จะได้คำสั่งเดิมกลับไป ไม่ยิงซ้ำ
 *  - การ "claim" คำสั่งเป็น UPDATE ... WHERE status='queued' แบบ atomic → จะมีผู้ประมวลผลคำสั่งหนึ่งๆ ได้คนเดียว
 *  - ส่งไปบอทด้วย retry + backoff ที่ gateway, ถ้ายังล้มเหลว → status failed พร้อมเหตุผลใน result
 *  - ถ้า process ตายกลางทาง คำสั่งที่ค้างจะถูก sweep() กู้คืนมาประมวลผลใหม่
 */
export function createCommandService({ db, hub, config, gateway }) {
  async function getCommand(id, client = db) {
    const { rows } = await client.query('SELECT * FROM oxide_bot_commands WHERE id = $1', [id]);
    if (!rows.length) throw notFound('command');
    return mapCommand(rows[0]);
  }

  async function process(id) {
    // claim แบบ atomic: ถ้ามีคนอื่นหยิบไปแล้วจะได้ 0 แถว
    const claimed = await db.query(
      `UPDATE oxide_bot_commands SET status = 'running' WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id]
    );
    if (!claimed.rowCount) return null;
    const cmd = claimed.rows[0];
    let status;
    let result;
    try {
      const { value, attempts } = await gateway.sendCommand(cmd.bot_id, cmd.command);
      if (value?.bot) await upsertBot(db, value.bot);
      status = 'success';
      result = { attempts, response: value };
    } catch (err) {
      status = 'failed';
      result = { attempts: err.attempts ?? 1, error: err.code ?? 'unknown_error', message: err.message };
    }
    await db.query(
      `UPDATE oxide_bot_commands SET status = $2, result = $3, completed_at = now() WHERE id = $1`,
      [id, status, JSON.stringify(result)]
    );
    await db.query(
      `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata) VALUES ($1, $2, 'bot', $3, $4)`,
      [cmd.requested_by, `command.${status}`, cmd.bot_id, JSON.stringify({ commandId: Number(cmd.id), command: cmd.command, ...result })]
    );
    hub.notify();
    return getCommand(id);
  }

  async function request(botId, command, { actor = 'dashboard', idempotencyKey } = {}) {
    if (!COMMANDS.includes(command)) throw badRequest(`command ต้องเป็นหนึ่งใน ${COMMANDS.join(', ')}`, 'invalid_command');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
      throw badRequest('Idempotency-Key ต้องยาว 1–200 ตัวอักษร');
    }

    const created = await db.tx(async (c) => {
      if (idempotencyKey) {
        // lock ตาม (บอท, key) เพื่อกันสองคำขอที่ key เดียวกันเข้ามาพร้อมกันแล้วต่างคนต่างไม่เห็นกัน
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cmd:${botId}:${idempotencyKey}`]);
        const prev = await c.query(
          `SELECT (metadata->>'commandId')::bigint AS id, metadata->>'command' AS command
             FROM audit_logs
            WHERE action = 'command.requested' AND target_id = $1 AND metadata->>'idempotencyKey' = $2
            ORDER BY id DESC LIMIT 1`,
          [botId, idempotencyKey]
        );
        if (prev.rowCount) {
          if (prev.rows[0].command !== command) {
            throw conflict('idempotency_key_reused', 'Idempotency-Key นี้เคยใช้กับคำสั่งอื่นแล้ว');
          }
          return { replayed: true, id: prev.rows[0].id };
        }
      }
      const bot = await c.query('SELECT 1 FROM oxide_bot_agents WHERE id = $1', [botId]);
      if (!bot.rowCount) throw notFound('bot');
      const ins = await c.query(
        `INSERT INTO oxide_bot_commands (bot_id, command, requested_by) VALUES ($1, $2, $3) RETURNING id`,
        [botId, command, actor]
      );
      const id = ins.rows[0].id;
      await c.query(
        `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata) VALUES ($1, 'command.requested', 'bot', $2, $3)`,
        [actor, botId, JSON.stringify({ commandId: id, command, idempotencyKey: idempotencyKey ?? null })]
      );
      return { replayed: false, id };
    });

    if (created.replayed) return { command: await getCommand(created.id), replayed: true };
    hub.notify();
    // ประมวลผลทันที; ถ้าไม่สำเร็จ process() จะบันทึก failed ไว้แล้ว (ไม่ throw)
    const done = await process(created.id);
    return { command: done ?? (await getCommand(created.id)), replayed: false };
  }

  /** กู้คืนคำสั่งค้าง: running นานเกินไป → กลับ queued, แล้วประมวลผล queued ที่เก่าเกินเกณฑ์ */
  async function sweep() {
    const stale = `now() - make_interval(secs => ${Number(config.commandStaleMs) / 1000})`;
    await db.query(`UPDATE oxide_bot_commands SET status = 'queued' WHERE status = 'running' AND created_at < ${stale}`);
    const { rows } = await db.query(
      `SELECT id FROM oxide_bot_commands WHERE status = 'queued' AND created_at < ${stale} ORDER BY id LIMIT 20`
    );
    let n = 0;
    for (const r of rows) if (await process(r.id)) n++;
    return n;
  }

  async function list(botId, limit = 50) {
    const { rows } = await db.query(
      `SELECT * FROM oxide_bot_commands WHERE ($1::text IS NULL OR bot_id = $1) ORDER BY id DESC LIMIT $2`,
      [botId ?? null, Math.min(Math.max(Number(limit) || 50, 1), 200)]
    );
    return rows.map(mapCommand);
  }

  return { request, process, sweep, getCommand, list };
}
