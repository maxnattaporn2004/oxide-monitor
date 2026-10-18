import { createDb } from './db.js';
import { createHub } from './events.js';
import { createKillSwitch } from './services/killSwitch.js';
import { createGateway } from './services/gateway.js';
import { createOrderService } from './services/orders.js';
import { createBotService } from './services/bots.js';
import { createCommandService } from './services/commands.js';
import { createMonitor } from './services/monitor.js';
import { createDeploymentService } from './services/deployments.js';

/** ประกอบ service ทั้งหมดเข้าด้วยกัน (dependency injection แบบง่าย — ทำให้เขียน test ได้ง่าย) */
export function createContext(config) {
  const db = createDb(config.databaseUrl);
  const hub = createHub();
  const killSwitch = createKillSwitch({ db, hub });
  const gateway = createGateway({
    baseUrl: config.botSimulatorUrl,
    timeoutMs: config.gatewayTimeoutMs,
    retries: config.commandRetries,
    retryBaseMs: config.retryBaseMs
  });
  const orders = createOrderService({ db, hub, config, killSwitch });
  const bots = createBotService({ db, hub, config, killSwitch, orders });
  const commands = createCommandService({ db, hub, config, gateway });
  const monitor = createMonitor({ db, hub, config, gateway, orders, commands });
  const deployments = createDeploymentService({ db, commands });
  return { config, db, hub, killSwitch, gateway, orders, bots, commands, monitor, deployments };
}
