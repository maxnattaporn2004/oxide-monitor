import { WebSocketServer } from 'ws';

/**
 * WebSocket สำหรับ Dashboard: ส่ง snapshot ล่าสุดตอนเชื่อมต่อ และส่งใหม่ทุกครั้งที่ข้อมูลเปลี่ยน
 * (ส่งทั้ง snapshot เพราะข้อมูลมีขนาดเล็ก ทำให้ฝั่ง client ไม่ต้อง merge event เอง)
 */
export function attachWebSocket(server, { bots, orders, hub }) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  async function snapshot() {
    return JSON.stringify({ type: 'snapshot', data: { ...(await bots.overview()), orders: await orders.listOrders({ limit: 50 }) } });
  }

  wss.on('connection', async (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
    try { socket.send(await snapshot()); } catch (err) { console.error('[ws] snapshot error:', err.message); }
  });

  const off = hub.onChange(async () => {
    if (!wss.clients.size) return;
    try {
      const msg = await snapshot();
      for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
    } catch (err) {
      console.error('[ws] broadcast error:', err.message);
    }
  });

  // ตัดการเชื่อมต่อที่ไม่ตอบ ping (client ที่หายไปเงียบๆ)
  const pinger = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, 30000);
  pinger.unref?.();

  return { close: () => { off(); clearInterval(pinger); wss.close(); } };
}
