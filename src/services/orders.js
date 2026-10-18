import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { CARRY_BOT, COARSE, STATES, canTransition, deriveState, isState } from '../orders/stateMachine.js';

/** state ละเอียดล่าสุดของแต่ละออเดอร์ (จาก order_events) — ใช้ต่อท้าย FROM orders o */
const LATEST = `LEFT JOIN LATERAL (
    SELECT payload->>'to' AS state, payload->>'botId' AS bot_id, created_at AS state_at
      FROM order_events
     WHERE order_id = o.id AND event_type = 'STATE_CHANGED'
     ORDER BY id DESC LIMIT 1) e ON true`;

const SELECT_ORDER = `SELECT o.*, e.state, e.bot_id, e.state_at FROM orders o ${LATEST}`;

function mapOrder(row) {
  const state = deriveState(row.status, row.state);
  const eventMatches = row.state === state;
  return {
    id: row.id,
    externalOrderId: row.external_order_id,
    state,
    status: row.status,
    botId: eventMatches ? row.bot_id : null,
    amount: row.amount,
    currency: row.currency,
    stateChangedAt: eventMatches ? row.state_at : row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createOrderService({ db, hub, config, killSwitch }) {
  const getRow = async (client, id) => (await client.query(`${SELECT_ORDER} WHERE o.id = $1`, [id])).rows[0];

  /** ล็อกแถวออเดอร์ (FOR UPDATE) แล้วอ่านสถานะล่าสุด — คนอื่นที่จะแก้ออเดอร์เดียวกันต้องรอจนเราจบทรานแซกชัน */
  const lockRow = async (client, id) =>
    (await client.query(`${SELECT_ORDER} WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];

  async function getOrder(id, client = db) {
    const row = await getRow(client, id);
    if (!row) throw notFound('order');
    return mapOrder(row);
  }

  /** รับได้ทั้ง id ตัวเลข หรือ external_order_id */
  async function resolveId(ref) {
    if (/^\d+$/.test(String(ref))) return Number(ref);
    const { rows } = await db.query('SELECT id FROM orders WHERE external_order_id = $1', [ref]);
    if (!rows.length) throw notFound('order');
    return rows[0].id;
  }

  async function writeTransition(c, row, to, { actor, reason, botId = null, extra = {} }) {
    const from = deriveState(row.status, row.state);
    await c.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [row.id, COARSE[to]]);
    await c.query(`INSERT INTO order_events (order_id, event_type, payload) VALUES ($1, 'STATE_CHANGED', $2)`, [
      row.id,
      JSON.stringify({ from, to, botId, reason: reason ?? null, actor: actor ?? 'system', ...extra })
    ]);
  }

  // ---------- สร้างออเดอร์ (idempotent ด้วย external_order_id) ----------
  async function createOrder({ externalOrderId, amount = 0, currency = 'THB', actor = 'system' }) {
    if (typeof externalOrderId !== 'string' || !externalOrderId.trim() || externalOrderId.length > 100) {
      throw badRequest('externalOrderId ต้องเป็นข้อความ 1–100 ตัวอักษร');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 9999999999) {
      throw badRequest('amount ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw badRequest('currency ต้องเป็นรหัส 3 ตัวอักษรพิมพ์ใหญ่ เช่น THB');
    }
    const ref = externalOrderId.trim();

    const result = await db.tx(async (c) => {
      // ON CONFLICT DO NOTHING: ถ้ามีสองคำขอพร้อมกัน ตัวที่สองจะรอตัวแรก commit แล้วได้ 0 แถว (ไม่ error)
      const ins = await c.query(
        `INSERT INTO orders (external_order_id, amount, currency) VALUES ($1, $2, $3)
         ON CONFLICT (external_order_id) DO NOTHING RETURNING id`,
        [ref, amount, currency]
      );
      if (ins.rowCount) {
        const id = ins.rows[0].id;
        await c.query(`INSERT INTO order_events (order_id, event_type, payload) VALUES ($1, 'STATE_CHANGED', $2)`, [
          id,
          JSON.stringify({ from: null, to: 'PENDING_PAYMENT', botId: null, reason: 'created', actor })
        ]);
        return { id, created: true };
      }
      const existing = (await c.query('SELECT id, amount, currency FROM orders WHERE external_order_id = $1', [ref])).rows[0];
      // external id เดิมแต่ข้อมูลต่างกัน แปลว่าไม่ใช่การส่งซ้ำ → แจ้ง conflict แทนการเงียบ
      if (Number(existing.amount) !== amount || existing.currency.trim() !== currency) {
        throw conflict('idempotency_mismatch', 'externalOrderId นี้มีอยู่แล้วด้วย amount/currency ที่ต่างกัน');
      }
      return { id: existing.id, created: false };
    });
    if (result.created) hub.notify();
    return { order: await getOrder(result.id), created: result.created };
  }

  // ---------- เปลี่ยนสถานะ ----------
  /**
   * opts: { actor, reason, botId, expectedFrom }
   *  - เป้าหมายตรงกับสถานะปัจจุบัน → no-op (idempotent) ไม่เขียน event ซ้ำ
   *  - expectedFrom: compare-and-set จากฝั่งผู้เรียก ถ้าสถานะไม่ตรงที่คาด → 409 state_conflict
   *  - botId: ถ้าระบุ ต้องตรงกับบอทที่ได้รับงาน ไม่งั้น 409 (กันบอทเก่าที่ถูกแทนที่แล้วมารายงานผลมั่ว)
   */
  async function transition(orderId, to, opts = {}) {
    if (!isState(to)) throw badRequest(`state ไม่ถูกต้อง ต้องเป็นหนึ่งใน ${STATES.join(', ')}`);
    const out = await db.tx(async (c) => {
      const row = await lockRow(c, orderId);
      if (!row) throw notFound('order');
      const from = deriveState(row.status, row.state);
      if (from === to) return { changed: false };
      if (opts.expectedFrom && opts.expectedFrom !== from) {
        throw conflict('state_conflict', `ออเดอร์อยู่ที่ ${from} แล้ว (คาดว่า ${opts.expectedFrom})`);
      }
      if (!canTransition(from, to)) {
        throw conflict('invalid_transition', `เปลี่ยนจาก ${from} เป็น ${to} ไม่ได้`);
      }
      const assigned = row.state === from ? row.bot_id : null;
      if (opts.botId && (from === 'IN_PROGRESS' || from === 'DELAYED') && assigned && assigned !== opts.botId) {
        throw conflict('wrong_bot', `ออเดอร์นี้ถูกมอบหมายให้ ${assigned} ไม่ใช่ ${opts.botId}`);
      }
      const botId = opts.botId ?? (CARRY_BOT.has(to) ? assigned : null);
      await writeTransition(c, row, to, { ...opts, botId });
      return { changed: true };
    });
    if (out.changed) hub.notify();
    return { ...out, order: await getOrder(orderId) };
  }

  // ---------- จ่ายงานให้บอท ----------
  /**
   * เลือกบอทที่ว่าง ภายในทรานแซกชันที่ถือ lock ของออเดอร์อยู่แล้ว
   * ล็อกแถวบอทที่ online ทั้งหมดเรียงตาม id (FOR UPDATE) ทำให้การจ่ายงานพร้อมกันถูกจัดเป็นคิวทีละตัว
   * พอได้ lock แล้วค่อยนับภาระงาน (READ COMMITTED เห็นงานที่ตัวก่อนหน้า commit แล้ว) จึงไม่มีบอทรับเกิน capacity
   */
  async function pickBot(c) {
    const bots = (
      await c.query(
        `SELECT id FROM oxide_bot_agents
          WHERE status = 'online' AND last_heartbeat > now() - make_interval(secs => $1)
          ORDER BY id FOR UPDATE`,
        [config.heartbeatTimeoutMs / 1000]
      )
    ).rows;
    if (!bots.length) return null;
    const load = new Map(bots.map((b) => [b.id, 0]));
    const busy = await c.query(
      `SELECT e.bot_id, count(*)::int AS n FROM orders o ${LATEST}
        WHERE o.status = 'processing' AND e.state = 'IN_PROGRESS' GROUP BY e.bot_id`
    );
    for (const r of busy.rows) if (load.has(r.bot_id)) load.set(r.bot_id, r.n);
    let best = null;
    for (const [id, n] of load) if (n < config.botCapacity && (best === null || n < load.get(best))) best = id;
    return best;
  }

  /** logic จ่ายงานจริง — เรียกเมื่อถือ lock ของแถวออเดอร์แล้วเท่านั้น */
  async function dispatchLocked(c, row, actor) {
    const from = deriveState(row.status, row.state);
    if (from === 'IN_PROGRESS') return { ok: true, changed: false };
    if (from !== 'QUEUED') return { ok: false, code: 'not_dispatchable', message: `ออเดอร์อยู่ที่ ${from} จ่ายงานไม่ได้ (ต้องเป็น QUEUED)` };
    if (!(await killSwitch.isEnabled(c))) return { ok: false, code: 'system_disabled', message: 'ระบบถูกปิดด้วย Kill-switch' };
    const botId = await pickBot(c);
    if (!botId) return { ok: false, code: 'no_bot_available', message: 'ไม่มีบอทที่ online และว่างรับงาน' };
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND event_type = 'STATE_CHANGED' AND payload->>'to' = 'IN_PROGRESS'`,
      [row.id]
    );
    await writeTransition(c, row, 'IN_PROGRESS', { actor, reason: 'dispatched', botId, extra: { attempt: rows[0].n + 1 } });
    return { ok: true, changed: true, botId };
  }

  async function dispatch(orderId, { actor = 'system' } = {}) {
    const out = await db.tx(async (c) => {
      const row = await lockRow(c, orderId);
      if (!row) throw notFound('order');
      return dispatchLocked(c, row, actor);
    });
    if (!out.ok) {
      const status = out.code === 'system_disabled' ? 423 : 409;
      throw new HttpError(status, out.code, out.message);
    }
    if (out.changed) hub.notify();
    return { changed: out.changed, order: await getOrder(orderId) };
  }

  /**
   * จ่ายงานออเดอร์ที่อยู่ QUEUED ตามลำดับเข้าก่อนออกก่อน
   * SKIP LOCKED: ถ้าอีก worker/คำขอกำลังจัดการออเดอร์นั้นอยู่ ให้ข้ามไปตัวถัดไป ไม่รอและไม่จ่ายซ้ำ
   */
  async function dispatchQueued(limit = 50) {
    let dispatched = 0;
    for (let i = 0; i < limit; i++) {
      const out = await db.tx(async (c) => {
        const found = await c.query(
          `SELECT o.id FROM orders o ${LATEST}
            WHERE o.status = 'pending' AND e.state = 'QUEUED'
            ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`
        );
        if (!found.rowCount) return { stop: true };
        const row = await lockRow(c, found.rows[0].id);
        const r = await dispatchLocked(c, row, 'auto-dispatcher');
        return r.ok ? { stop: false, changed: r.changed } : { stop: true };
      });
      if (out.stop) break;
      if (out.changed) dispatched++;
    }
    if (dispatched) hub.notify();
    return dispatched;
  }

  // ---------- งานของ monitor ----------
  /** ออเดอร์ IN_PROGRESS ที่บอทเจ้าของงาน "ไม่ online แล้ว" (หลุด/ดับ/ไม่มีในระบบ) */
  async function findOrdersOnLostBots() {
    const { rows } = await db.query(
      `SELECT o.id, b.status AS bot_status FROM orders o ${LATEST}
         LEFT JOIN oxide_bot_agents b ON b.id = e.bot_id
        WHERE o.status = 'processing' AND e.state = 'IN_PROGRESS'
          AND (b.id IS NULL OR b.status <> 'online')`
    );
    return rows;
  }

  async function markDelayed(orderId, reason) {
    try {
      return (await transition(orderId, 'DELAYED', { actor: 'heartbeat-monitor', reason, expectedFrom: 'IN_PROGRESS' })).changed;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return false; // มีคนเปลี่ยนสถานะไปก่อนแล้ว ไม่ใช่ปัญหา
      throw err;
    }
  }

  /** ออเดอร์ DELAYED ที่รอเกินเวลา: ยังมีโควตา retry → กลับ QUEUED เพื่อจ่ายให้บอทอื่น, หมดโควตา → FAILED */
  async function resolveExpiredDelayed() {
    const ids = (
      await db.query(
        `SELECT o.id FROM orders o ${LATEST}
          WHERE o.status = 'processing' AND e.state = 'DELAYED'
            AND e.state_at < now() - make_interval(secs => $1)`,
        [config.delayedGraceMs / 1000]
      )
    ).rows;
    let resolved = 0;
    for (const { id } of ids) {
      const changed = await db.tx(async (c) => {
        const row = await lockRow(c, id);
        if (!row || deriveState(row.status, row.state) !== 'DELAYED') return false;
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND event_type = 'STATE_CHANGED' AND payload->>'to' = 'IN_PROGRESS'`,
          [id]
        );
        const attempts = rows[0].n;
        if (attempts < config.maxDispatchAttempts) {
          await writeTransition(c, row, 'QUEUED', { actor: 'heartbeat-monitor', reason: 'retry_after_delay', extra: { attempts } });
        } else {
          await writeTransition(c, row, 'FAILED', {
            actor: 'heartbeat-monitor', reason: 'max_attempts_exceeded', botId: row.bot_id, extra: { attempts }
          });
        }
        return true;
      });
      if (changed) resolved++;
    }
    if (resolved) hub.notify();
    return resolved;
  }

  // ---------- query ----------
  async function listOrders({ state, limit = 100 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (state && !isState(state)) throw badRequest(`state ไม่ถูกต้อง ต้องเป็นหนึ่งใน ${STATES.join(', ')}`);
    const { rows } = await db.query(`${SELECT_ORDER} ORDER BY o.id DESC LIMIT $1`, [state ? 500 : lim]);
    const orders = rows.map(mapOrder);
    return (state ? orders.filter((o) => o.state === state) : orders).slice(0, lim);
  }

  async function getTimeline(orderId) {
    await getOrder(orderId);
    const { rows } = await db.query(
      'SELECT id, event_type, payload, created_at FROM order_events WHERE order_id = $1 ORDER BY id',
      [orderId]
    );
    return rows.map((r) => ({ id: r.id, eventType: r.event_type, payload: r.payload, createdAt: r.created_at }));
  }

  return {
    resolveId, getOrder, createOrder, transition, dispatch, dispatchQueued,
    findOrdersOnLostBots, markDelayed, resolveExpiredDelayed, listOrders, getTimeline,
    /** ใช้ภายใน service อื่นที่ต้องแปะ SQL ส่วน "state ล่าสุด" เดียวกัน */
    sql: { LATEST }
  };
}
