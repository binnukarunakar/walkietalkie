import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RoomManager } from "./rooms.js";
import { TokenService } from "./tokens.js";
import { attachWebSocket } from "./ws.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.clientDist === null) {
    const here = dirname(fileURLToPath(import.meta.url));
    config.clientDist = resolve(here, "../../client/dist");
  }

  const tokens = new TokenService(config.sessionSecret);
  const roomManager = new RoomManager({
    maxChannelSize: config.maxChannelSize,
    ...(config.maxHoldMs !== undefined ? { maxHoldMs: config.maxHoldMs } : {}),
  });
  const app = await buildApp({ config, tokens, roomManager });

  if (config.sessionSecretGenerated) {
    app.log.warn(
      "SESSION_SECRET not set — using a per-boot key. Fine for a single instance; set it to survive restarts or run replicas.",
    );
  }

  const wss = attachWebSocket(app.server, {
    tokens,
    roomManager,
    log: {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
    },
  });

  const shutdown = (signal: string): void => {
    app.log.info(`${signal} received, shutting down`);
    for (const client of wss.clients) {
      client.close(1001, "server shutting down");
    }
    wss.close();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
