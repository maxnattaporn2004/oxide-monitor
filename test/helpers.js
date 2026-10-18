import http from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';

/** test ใช้ฐานข้อมูลแยกชื่อ *_test เสมอ เพื่อไม่ไปล้างข้อมูลของฐานที่ใช้งานจริง */
function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/oxide_monitor_test';
  return url.toString();
}

async function ensureTestDatabase(url) {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

/** Bot Simulator จำลองแบบควบคุมได้: สั่งให้ล้มเหลวกี่ครั้งก็ได้ และนับจำนวน request ที่เข้ามา */
export async function startFakeSimulator() {
  const state = { failNext: 0, failStatus: 500, commandCalls: 0, bots: new Map() };
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/bots') return send(200, [...state.bots.values()]);
    const m = req.url.match(/^\/bots\/([^/]+)\/commands$/);
    if (req.method === 'POST' && m) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      state.commandCalls++;
      if (state.failNext > 0) { state.failNext--; return send(state.failStatus, { error: 'boom' }); }
      const bot = state.bots.get(m[1]);
      if (!bot) return send(404, { error: 'bot_not_found' });
      const { command } = JSON.parse(raw || '{}');
      if (command === 'start' || command === 'restart') bot.status = 'online';
      if (command === 'stop') bot.status = 'offline';
      return send(200, { ok: true, bot, command });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addBot = (id, status = 'online') =>
    state.bots.set(id, { id, name: `Bot ${id}`, deviceName: `dev-${id}`, status, cpuPercent: 10, memoryPercent: 20, uptimeSeconds: 100 });
  return {
    state, addBot,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}

/**
 * สร้าง context ใหม่พร้อมฐานข้อมูลทดสอบที่สะอาด
 * overrides: ค่า config ที่อยากปรับ, bots: บอทที่ต้องการให้ online ตั้งแต่เริ่ม (heartbeat = ตอนนี้)
 */
export async function setup({ bots = ['bot-01', 'bot-02'], simulatorUrl = 'http://127.0.0.1:1', ...overrides } = {}) {
  const url = testDatabaseUrl();
  await ensureTestDatabase(url);
  const config = {
    ...loadConfig({ ...process.env, DATABASE_URL: url, BOT_SIMULATOR_URL: simulatorUrl }),
    autoDispatch: false, retryBaseMs: 5, gatewayTimeoutMs: 1000, ...overrides
  };
  const ctx = createContext(config);
  await ctx.db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await ctx.db.query('TRUNCATE order_events, orders, oxide_bot_commands, audit_logs, oxide_bot_agents RESTART IDENTITY CASCADE');
  for (const id of bots) {
    await ctx.db.query(
      `INSERT INTO oxide_bot_agents (id, name, device_name, status, last_heartbeat) VALUES ($1, $2, $3, 'online', now())`,
      [id, `Bot ${id}`, `dev-${id}`]
    );
  }
  return ctx;
}

/** เปิด HTTP server จริงของ app บน port สุ่ม เพื่อทดสอบทั้ง stack ผ่าน fetch */
export async function startApi(ctx) {
  const server = http.createServer(createApp(ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { base, call, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** สร้างออเดอร์แล้วดันให้ถึงสถานะ QUEUED */
export async function queuedOrder(ctx, externalOrderId, amount = 100) {
  const { order } = await ctx.orders.createOrder({ externalOrderId, amount });
  await ctx.orders.transition(order.id, 'QUEUED', { actor: 'test', reason: 'paid' });
  return order.id;
}

export const eventsOf = async (ctx, orderId) =>
  (await ctx.db.query(`SELECT payload FROM order_events WHERE order_id = $1 ORDER BY id`, [orderId])).rows.map((r) => r.payload);
