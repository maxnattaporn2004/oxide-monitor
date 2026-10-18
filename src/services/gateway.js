/**
 * BotGateway — ชั้นติดต่อกับ Bot (ที่นี่คือ Bot Simulator แบบ REST)
 *
 * แยกเป็น adapter เดียวเพื่อให้สลับเป็น WebSocket/MQTT/gRPC ได้ภายหลังโดยไม่แตะ service อื่น
 * มี timeout ต่อ request และ retry แบบ exponential backoff + jitter
 * retry เฉพาะความผิดพลาดชั่วคราว (network, timeout, 5xx, 429) — 4xx ไม่ retry เพราะลองซ้ำก็ผลเดิม
 */
export class GatewayError extends Error {
  constructor(code, status, retryable, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.attempts = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGateway({ baseUrl, timeoutMs, retries, retryBaseMs }) {
  async function request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* ไม่ใช่ JSON */ }
      if (!res.ok) {
        throw new GatewayError(data?.error ?? `http_${res.status}`, res.status, res.status >= 500 || res.status === 429);
      }
      return data;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(err.name === 'AbortError' ? 'timeout' : 'network_error', 0, true, err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** ลองซ้ำพร้อมหน่วงเวลา: base * 2^(n-1) คูณ jitter 0.5–1.0 เพื่อไม่ให้หลายคำสั่งลองซ้ำพร้อมกันเป๊ะ */
  async function withRetry(fn, maxRetries) {
    for (let attempt = 1; ; attempt++) {
      try {
        return { value: await fn(), attempts: attempt };
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        err.attempts = attempt;
        if (!err.retryable || attempt > maxRetries) throw err;
        await sleep(retryBaseMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5));
      }
    }
  }

  return {
    /** อ่านสถานะบอททั้งหมด — ไม่ retry เพราะ poll รอบถัดไปจะมาอยู่แล้ว */
    async listBots() {
      return (await withRetry(() => request('GET', '/bots'), 0)).value;
    },
    /** ส่งคำสั่งให้บอท พร้อม retry — คืน { value, attempts } */
    sendCommand(botId, command) {
      return withRetry(() => request('POST', `/bots/${encodeURIComponent(botId)}/commands`, { command }), retries);
    }
  };
}
