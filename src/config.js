const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('ไม่พบ DATABASE_URL — คัดลอก .env.example เป็น .env ก่อน (cp .env.example .env)');
  }
  return {
    port: num(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL,
    botSimulatorUrl: (env.BOT_SIMULATOR_URL ?? 'http://localhost:8788').replace(/\/$/, ''),
    heartbeatTimeoutMs: num(env.HEARTBEAT_TIMEOUT_MS, 15000),
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 5000),
    delayedGraceMs: num(env.DELAYED_GRACE_MS, 60000),
    maxDispatchAttempts: num(env.MAX_DISPATCH_ATTEMPTS, 3),
    botCapacity: num(env.BOT_CAPACITY, 1),
    commandRetries: num(env.COMMAND_RETRIES, 3),
    retryBaseMs: num(env.RETRY_BASE_MS, 300),
    gatewayTimeoutMs: num(env.GATEWAY_TIMEOUT_MS, 3000),
    autoDispatch: (env.AUTO_DISPATCH ?? 'true') !== 'false',
    // คำสั่งที่ค้าง queued/running นานกว่านี้ (ms) จะถูกกู้คืนโดย sweep
    commandStaleMs: num(env.COMMAND_STALE_MS, 10000)
  };
}
