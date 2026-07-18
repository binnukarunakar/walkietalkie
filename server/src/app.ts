import { existsSync } from "node:fs";
import fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  callsignSchema,
  createGroupSchema,
  groupRoomKey,
  joinRequestSchema,
  roomKey,
} from "@walkietalkie/shared";
import type { AppConfig } from "./config.js";
import type { GroupRegistry } from "./groups.js";
import type { RoomManager } from "./rooms.js";
import type { TokenService } from "./tokens.js";

export interface AppDeps {
  config: AppConfig;
  tokens: TokenService;
  roomManager: RoomManager;
  groups: GroupRegistry;
}

const announceRequestSchema = z.object({
  adminKey: z.string().min(16).max(64),
  callsign: callsignSchema,
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, tokens, roomManager, groups } = deps;
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
      const { channel, code, callsign, groupId } = parsed.data;

      let key: string;
      if (groupId !== undefined) {
        const group = groups.get(groupId);
        if (group === undefined) {
          return reply.code(404).send({ error: "group-not-found" });
        }
        const member = group.channels.some((c) => c.channel === channel && c.code === code);
        if (!member) {
          return reply.code(400).send({ error: "channel-not-in-group" });
        }
        key = groupRoomKey(groupId, channel, code);
      } else {
        key = roomKey(channel, code);
      }

      const check = roomManager.canJoin(key, callsign);
      if (!check.ok) {
        const status = check.code === "full" ? 423 : 409;
        return reply.code(status).send({ error: check.code });
      }

      const token = await tokens.issue({
        rooms: [key],
        callsign,
        mode: "member",
        ...(groupId !== undefined ? { group: groupId } : {}),
      });
      return reply.send({ token });
    },
  );

  app.post(
    "/api/groups",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = createGroupSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid-request", detail: parsed.error.issues[0]?.message });
      }
      const created = groups.create(parsed.data.name, parsed.data.channels);
      if (created === null) {
        return reply.code(503).send({ error: "group-capacity" });
      }
      return reply.send({
        groupId: created.group.groupId,
        name: created.group.name,
        adminKey: created.adminKey,
      });
    },
  );

  app.get("/api/groups/:groupId", async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const group = groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ error: "group-not-found" });
    }
    return groups.info(group);
  });

  app.post(
    "/api/groups/:groupId/announce",
    { config: { rateLimit: { max: config.joinRateMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { groupId } = request.params as { groupId: string };
      const parsed = announceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      const group = groups.get(groupId);
      if (group === undefined) {
        return reply.code(404).send({ error: "group-not-found" });
      }
      if (!groups.verifyAdmin(groupId, parsed.data.adminKey)) {
        return reply.code(403).send({ error: "bad-admin-key" });
      }
      if (groups.totalOccupancy(group) > config.maxGroupMembers) {
        return reply.code(423).send({ error: "group-too-large" });
      }
      const keys = groups.roomKeys(group);
      for (const key of keys) {
        const check = roomManager.canJoin(key, parsed.data.callsign);
        if (!check.ok) {
          return reply.code(check.code === "full" ? 423 : 409).send({ error: check.code });
        }
      }
      const token = await tokens.issue({
        rooms: keys,
        callsign: parsed.data.callsign,
        mode: "announce",
        group: groupId,
      });
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
