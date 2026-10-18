import { upsertBot } from './bots.js';

/**
 * Heartbeat monitor — วนทำงานทุก POLL_INTERVAL_MS
 *
 *  1) poll Bot Simulator (REST ไม่มี push) — การตอบกลับ + สถานะ online ของบอท = heartbeat
 *  2) บอทที่ status=online แต่ heartbeat เงียบเกิน HEARTBEAT_TIMEOUT_MS → status 'error' (หลุด)
 *  3) ออเดอร์ IN_PROGRESS ของบอทที่ไม่ online → DELAYED
 *  4) ออเดอร์ DELAYED ที่รอเกิน DELAYED_GRACE_MS → กลับ QUEUED (retry) หรือ FAILED ถ้าครบโควตา
 *  5) กู้คืนคำสั่งค้าง และจ่ายงานออเดอร์ QUEUED (ถ้าเปิด AUTO_DISPATCH และ kill-switch เปิดอยู่)
 *
 * ทุกขั้นเป็น idempotent จึงรันซ้ำ/รันซ้อนหลาย instance ได้อย่างปลอดภัย
 */
export function createMonitor({ db, hub, config, gateway, orders, commands }) {
  let timer = null;
  let running = false;

  async function pollBots() {
    let bots;
    try {
      bots = await gateway.listBots();
    } catch (err) {
      console.warn(`[monitor] poll simulator ไม่สำเร็จ: ${err.message}`);
      return { ok: false };
    }
    if (!Array.isArray(bots)) return { ok: false };
    for (const bot of bots) await upsertBot(db, bot);
    return { ok: true, count: bots.length };
  }

  async function sweepOnce() {
    const lost = await db.query(
      `UPDATE oxide_bot_agents SET status = 'error', updated_at = now()
        WHERE status = 'online' AND COALESCE(last_heartbeat, updated_at) < now() - make_interval(secs => $1)
        RETURNING id`,
      [config.heartbeatTimeoutMs / 1000]
    );
    for (const { id } of lost.rows) {
      await db.query(
        `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata)
         VALUES ('heartbeat-monitor', 'bot.heartbeat_lost', 'bot', $1, $2)`,
        [id, JSON.stringify({ timeoutMs: config.heartbeatTimeoutMs })]
      );
    }
    if (lost.rowCount) hub.notify();

    let delayed = 0;
    for (const o of await orders.findOrdersOnLostBots()) {
      if (await orders.markDelayed(o.id, o.bot_status === 'error' ? 'heartbeat_timeout' : 'bot_offline')) delayed++;
    }
    const resolved = await orders.resolveExpiredDelayed();
    await commands.sweep();
    const dispatched = config.autoDispatch ? await orders.dispatchQueued() : 0;
    return { lostBots: lost.rowCount, delayed, resolved, dispatched };
  }

  async function tick() {
    if (running) return; // กัน tick ซ้อนกัน ถ้ารอบก่อนยังไม่จบ
    running = true;
    try {
      await pollBots();
      await sweepOnce();
    } catch (err) {
      console.error('[monitor] tick error:', err);
    } finally {
      running = false;
    }
  }

  return {
    pollBots, sweepOnce, tick,
    /** เรียกหลังมีออเดอร์เข้าคิว เพื่อให้จ่ายงานเร็วโดยไม่ต้องรอรอบ poll ถัดไป */
    async kick() {
      if (!config.autoDispatch) return 0;
      try { return await orders.dispatchQueued(); } catch (err) { console.error('[monitor] kick error:', err); return 0; }
    },
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, config.pollIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
