import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, badRequest } from './errors.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const actorOf = (req) => String(req.get('x-actor') ?? 'dashboard').slice(0, 100);

export function createApp(ctx) {
  const { db, orders, bots, commands, killSwitch, deployments, monitor } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', wrap(async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  }));

  // ---------- ภาพรวม / บอท ----------
  app.get('/overview', wrap(async (_req, res) => {
    res.json({ ...(await bots.overview()), orders: await orders.listOrders({ limit: 50 }) });
  }));
  app.get('/summary', wrap(async (_req, res) => {
    const { killSwitch: ks, summary } = await bots.overview();
    res.json({ killSwitch: ks, ...summary });
  }));
  app.get('/bots', wrap(async (_req, res) => res.json((await bots.overview()).bots)));
  app.get('/bots/:id', wrap(async (req, res) => res.json(await bots.getBot(req.params.id))));
  app.get('/bots/:id/commands', wrap(async (req, res) => res.json(await commands.list(req.params.id, req.query.limit))));

  app.post('/bots/:id/commands', wrap(async (req, res) => {
    const { command } = req.body ?? {};
    const { command: cmd, replayed } = await commands.request(req.params.id, command, {
      actor: actorOf(req),
      idempotencyKey: req.get('idempotency-key') ?? undefined
    });
    if (replayed) res.set('Idempotent-Replayed', 'true');
    // สั่งแล้วบอทไม่ตอบ (failed) = ปลายทางมีปัญหา → 502 ให้ client รู้ว่าไม่สำเร็จ
    res.status(cmd.status === 'failed' ? 502 : replayed ? 200 : 201).json(cmd);
  }));

  // ---------- Kill-switch ----------
  app.get('/system/kill-switch', wrap(async (_req, res) => res.json(await killSwitch.read())));
  app.put('/system/kill-switch', wrap(async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') throw badRequest('enabled ต้องเป็น true/false');
    const { changed, state } = await killSwitch.set(enabled, actorOf(req));
    res.json({ changed, ...state });
  }));

  // ---------- ออเดอร์ ----------
  app.post('/orders', wrap(async (req, res) => {
    const { externalOrderId, amount, currency } = req.body ?? {};
    const { order, created } = await orders.createOrder({ externalOrderId, amount, currency, actor: actorOf(req) });
    res.status(created ? 201 : 200).json({ ...order, created });
  }));
  app.get('/orders', wrap(async (req, res) => res.json(await orders.listOrders({ state: req.query.state, limit: req.query.limit }))));
  app.get('/orders/:ref', wrap(async (req, res) => res.json(await orders.getOrder(await orders.resolveId(req.params.ref)))));
  app.get('/orders/:ref/timeline', wrap(async (req, res) => res.json(await orders.getTimeline(await orders.resolveId(req.params.ref)))));

  const orderAction = (handler) => wrap(async (req, res) => {
    const id = await orders.resolveId(req.params.ref);
    const out = await handler(id, req);
    res.json({ changed: out.changed, order: out.order });
  });

  app.post('/orders/:ref/pay', orderAction(async (id, req) => {
    const out = await orders.transition(id, 'QUEUED', { actor: actorOf(req), reason: 'payment_confirmed', expectedFrom: undefined });
    monitor.kick();
    return out;
  }));
  app.post('/orders/:ref/dispatch', orderAction((id, req) => orders.dispatch(id, { actor: actorOf(req) })));
  app.post('/orders/:ref/cancel', orderAction((id, req) =>
    orders.transition(id, 'CANCELLED', { actor: actorOf(req), reason: req.body?.reason ?? 'cancelled' })));

  /** บอทรายงานผล/ระบบเปลี่ยนสถานะ — body: { to, botId?, reason?, expectedFrom? } (ไป IN_PROGRESS ต้องใช้ /dispatch) */
  app.post('/orders/:ref/transition', orderAction((id, req) => {
    const { to, botId, reason, expectedFrom } = req.body ?? {};
    if (to === 'IN_PROGRESS') throw badRequest('ใช้ POST /orders/:ref/dispatch เพื่อจ่ายงานให้บอท', 'use_dispatch');
    return orders.transition(id, to, { actor: actorOf(req), reason, botId, expectedFrom });
  }));

  // ---------- Deployment / Audit ----------
  app.post('/deployments', wrap(async (req, res) => {
    const { packageName, botIds } = req.body ?? {};
    res.json(await deployments.deploy({ packageName, botIds, actor: actorOf(req) }));
  }));
  app.get('/audit-logs', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const { rows } = await db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1', [limit]);
    res.json(rows.map((r) => ({
      id: r.id, actor: r.actor, action: r.action, targetType: r.target_type, targetId: r.target_id,
      metadata: r.metadata, createdAt: r.created_at
    })));
  }));

  app.use(express.static(publicDir));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'JSON ไม่ถูกต้อง' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error('[api] unexpected error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
