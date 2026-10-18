import http from 'node:http';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
import { attachWebSocket } from './ws.js';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
const server = http.createServer(app);
const ws = attachWebSocket(server, ctx);

server.listen(config.port, () => {
  console.log(`Oxide Monitor API + Dashboard: http://localhost:${config.port}`);
  console.log(`Bot Simulator: ${config.botSimulatorUrl}`);
  ctx.monitor.start();
});

async function shutdown(signal) {
  console.log(`\n${signal} — กำลังปิดระบบ...`);
  ctx.monitor.stop();
  ws.close();
  server.close(async () => {
    await ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
