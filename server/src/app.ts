import { existsSync } from "node:fs";
import fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { joinRequestSchema, roomKey } from "@walkietalkie/shared";
import type { AppConfig } from "./config.js";
import type { RoomManager } from "./rooms.js";
import type { TokenService } from "./tokens.js";

export interface AppDeps {
  config: AppConfig;
  tokens: TokenService;
  roomManager: RoomManager;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, tokens, roomManager } = deps;
  const app = fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  app.post(
    "/api/join",
    { config: { rateLimit: { max: config.joinRateMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = joinRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid-request", detail: parsed.error.issues[0]?.message });
      }
      const { channel, code, callsign } = parsed.data;
      const key = roomKey(channel, code);

      const check = roomManager.canJoin(key, callsign);
      if (!check.ok) {
        const status = check.code === "full" ? 423 : 409;
        return reply.code(status).send({ error: check.code });
      }

      const token = await tokens.issue({ room: key, callsign });
      return reply.send({ token });
    },
  );

  app.get("/api/ice", async () => {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> =
      [{ urls: config.stunUrls }];
    if (config.turn !== null) {
      iceServers.push({
        urls: config.turn.url,
        username: config.turn.username,
        credential: config.turn.credential,
      });
    }
    return { iceServers };
  });

  app.get("/api/channels", async () => {
    return { open: roomManager.openChannelOccupancy() };
  });

  app.get("/healthz", async () => {
    return { ok: true, ...roomManager.stats };
  });

  if (config.clientDist !== null && existsSync(config.clientDist)) {
    // wildcard (default) resolves files from disk per request. `wildcard:
    // false` would snapshot routes at boot — a rebuild under a running
    // server would then serve index.html for the new hashed assets.
    await app.register(fastifyStatic, {
      root: config.clientDist,
    });
    // SPA fallback: any non-API GET serves the client shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not-found" });
    });
  }

  return app;
}
