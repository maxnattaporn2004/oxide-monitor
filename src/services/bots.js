import { notFound } from '../errors.js';
import { deriveState } from '../orders/stateMachine.js';

const BOT_STATUSES = new Set(['online', 'offline', 'starting', 'stopping', 'error']);

/** บันทึกสถานะที่บอทรายงาน (จาก poll หรือจากผลคำสั่ง) ลงตาราง oxide_bot_agents */
export async function upsertBot(client, bot) {
  const status = BOT_STATUSES.has(bot.status) ? bot.status : 'error';
  await client.query(
    `INSERT INTO oxide_bot_agents (id, name, device_name, status, cpu_percent, memory_percent, uptime_seconds, last_heartbeat)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'online' THEN now() END)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, device_name = EXCLUDED.device_name, status = EXCLUDED.status,
       cpu_percent = EXCLUDED.cpu_percent, memory_percent = EXCLUDED.memory_percent,
       uptime_seconds = EXCLUDED.uptime_seconds,
       last_heartbeat = COALESCE(EXCLUDED.last_heartbeat, oxide_bot_agents.last_heartbeat),
       updated_at = now()`,
    [
      String(bot.id), bot.name ?? String(bot.id), bot.deviceName ?? 'unknown', status,
      Number(bot.cpuPercent) || 0, Number(bot.memoryPercent) || 0, Math.max(0, Math.trunc(Number(bot.uptimeSeconds) || 0))
    ]
  );
}

export function createBotService({ db, hub, config, killSwitch, orders }) {
  const { LATEST } = orders.sql;

  /** ภาพรวมทั้งหมดที่ Dashboard ต้องใช้ (บอท + สรุป + kill-switch) ในการอ่านชุดเดียว */
  async function overview() {
    const [ks, botRows, inProgress, lastResults, lastCommands, counts] = await Promise.all([
      killSwitch.read(),
      db.query(`SELECT *, EXTRACT(EPOCH FROM (now() - last_heartbeat))::int AS hb_age FROM oxide_bot_agents ORDER BY id`),
      db.query(
        `SELECT o.external_order_id, e.bot_id FROM orders o ${LATEST}
          WHERE o.status = 'processing' AND e.state = 'IN_PROGRESS' ORDER BY o.id`
      ),
      db.query(
        `SELECT DISTINCT ON (e.payload->>'botId') e.payload->>'botId' AS bot_id, e.payload->>'to' AS state,
                o.external_order_id, e.created_at
           FROM order_events e JOIN orders o ON o.id = e.order_id
          WHERE e.event_type = 'STATE_CHANGED' AND e.payload->>'to' IN ('COMPLETED','FAILED') AND e.payload->>'botId' IS NOT NULL
          ORDER BY e.payload->>'botId', e.id DESC`
      ),
      db.query(
        `SELECT DISTINCT ON (bot_id) bot_id, command, status, created_at FROM oxide_bot_commands ORDER BY bot_id, id DESC`
      ),
      db.query(
        `SELECT e.state, o.status, count(*)::int AS n FROM orders o ${LATEST} GROUP BY e.state, o.status`
      )
    ]);

    const currentByBot = new Map();
    for (const r of inProgress.rows) {
      if (!currentByBot.has(r.bot_id)) currentByBot.set(r.bot_id, []);
      currentByBot.get(r.bot_id).push(r.external_order_id);
    }
    const lastResultByBot = new Map(lastResults.rows.map((r) => [r.bot_id, r]));
    const lastCommandByBot = new Map(lastCommands.rows.map((r) => [r.bot_id, r]));

    const bots = botRows.rows.map((b) => {
      const current = currentByBot.get(b.id) ?? [];
      let botState;
      if (b.status === 'error') botState = 'lost';
      else if (b.status !== 'online') botState = 'offline';
      else if (current.length) botState = 'busy';
      else if (!ks.enabled) botState = 'paused';
      else botState = 'standby';
      const lr = lastResultByBot.get(b.id);
      const lc = lastCommandByBot.get(b.id);
      return {
        id: b.id, name: b.name, deviceName: b.device_name, status: b.status, botState,
        cpuPercent: b.cpu_percent, memoryPercent: b.memory_percent, uptimeSeconds: b.uptime_seconds,
        lastHeartbeat: b.last_heartbeat, heartbeatAgeSeconds: b.hb_age,
        currentOrders: current,
        lastResult: lr ? { state: lr.state, externalOrderId: lr.external_order_id, at: lr.created_at } : null,
        lastCommand: lc ? { command: lc.command, status: lc.status, at: lc.created_at } : null
      };
    });

    const online = bots.filter((b) => b.status === 'online');
    const byState = {};
    for (const r of counts.rows) {
      const s = deriveState(r.status, r.state);
      byState[s] = (byState[s] ?? 0) + r.n;
    }
    const summary = {
      onlineCount: online.length,
      // active = บอทที่ online และระบบเปิดรับงานอยู่ (ถูก kill-switch ปิดแล้วเป็น 0)
      activeCount: ks.enabled ? online.length : 0,
      // standby = active แต่ยังไม่มีงานในมือ
      standbyCount: ks.enabled ? online.filter((b) => b.botState === 'standby').length : 0,
      inProgressCount: byState.IN_PROGRESS ?? 0,
      totalBots: bots.length
    };
    return { killSwitch: ks, summary: { ...summary, ordersByState: byState }, bots };
  }

  async function getBot(id) {
    const { rows } = await db.query('SELECT id FROM oxide_bot_agents WHERE id = $1', [id]);
    if (!rows.length) throw notFound('bot');
    const ov = await overview();
    const bot = ov.bots.find((b) => b.id === id);
    const commands = await db.query(
      `SELECT id, command, requested_by, status, result, created_at, completed_at
         FROM oxide_bot_commands WHERE bot_id = $1 ORDER BY id DESC LIMIT 20`,
      [id]
    );
    const recent = await db.query(
      `SELECT o.external_order_id, e.state, e.state_at FROM orders o ${LATEST}
        WHERE e.bot_id = $1 ORDER BY e.state_at DESC LIMIT 20`,
      [id]
    );
    return {
      ...bot,
      commands: commands.rows.map((c) => ({
        id: c.id, command: c.command, requestedBy: c.requested_by, status: c.status,
        result: c.result, createdAt: c.created_at, completedAt: c.completed_at
      })),
      recentOrders: recent.rows.map((r) => ({ externalOrderId: r.external_order_id, state: r.state, at: r.state_at }))
    };
  }

  return { overview, getBot };
}
