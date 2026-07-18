import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { GroupRegistry } from "../src/groups.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { RoomManager } from "../src/rooms.js";
import { TokenService } from "../src/tokens.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config = loadConfig({ LOG_LEVEL: "error" });
  return { ...config, ...overrides };
}

async function makeApp(overrides: Partial<AppConfig> = {}): Promise<{
  app: FastifyInstance;
  roomManager: RoomManager;
  groups: GroupRegistry;
}> {
  const config = testConfig(overrides);
  const tokens = new TokenService(config.sessionSecret);
  const roomManager = new RoomManager({ maxChannelSize: config.maxChannelSize });
  const groups = new GroupRegistry((key) => roomManager.sizeOf(key));
  const app = await buildApp({ config, tokens, roomManager, groups });
  return { app, roomManager, groups };
}

const validBody = { channel: 3, code: 7, callsign: "Alpha" };

describe("POST /api/join", () => {
  it("issues a token for a valid request", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/api/join", payload: validBody });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("token");
  });

  it("rejects out-of-range channel, code, and bad callsigns", async () => {
    const { app } = await makeApp();
    for (const payload of [
      { ...validBody, channel: 23 },
      { ...validBody, channel: 0 },
      { ...validBody, code: 39 },
      { ...validBody, callsign: "x" },
      { ...validBody, callsign: "way too long callsign here" },
      { ...validBody, callsign: "bad<script>" },
      { channel: 3 },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/join", payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("409s on a live callsign collision", async () => {
    const { app, roomManager } = await makeApp();
    roomManager.join("3:7", "Alpha", vi.fn(), vi.fn());
    const res = await app.inject({ method: "POST", url: "/api/join", payload: validBody });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "callsign-taken" });
  });

  it("423s when the channel is full", async () => {
    const { app, roomManager } = await makeApp({ maxChannelSize: 2 });
    roomManager.join("3:7", "One", vi.fn(), vi.fn());
    roomManager.join("3:7", "Two", vi.fn(), vi.fn());
    const res = await app.inject({ method: "POST", url: "/api/join", payload: validBody });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toEqual({ error: "full" });
  });

  it("rate-limits after 10 requests in a minute from one IP", async () => {
    const { app } = await makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/join",
        payload: { ...validBody, callsign: `Caller${i}` },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("GET /api/ice", () => {
  it("returns STUN only by default", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/ice" });
    const body = res.json() as { iceServers: Array<{ urls: string[]; username?: string }> };
    expect(body.iceServers).toHaveLength(1);
    expect(body.iceServers[0]?.urls).toEqual(["stun:stun.l.google.com:19302"]);
  });

  it("includes TURN when configured", async () => {
    const { app } = await makeApp({
      turn: { url: "turn:turn.example.net:3478", username: "u", credential: "c" },
    });
    const res = await app.inject({ method: "GET", url: "/api/ice" });
    const body = res.json() as { iceServers: unknown[] };
    expect(body.iceServers).toHaveLength(2);
  });
});

describe("GET /api/channels & /healthz", () => {
  it("reports open-channel occupancy and health stats", async () => {
    const { app, roomManager } = await makeApp();
    roomManager.join("3:0", "Alpha", vi.fn(), vi.fn());
    roomManager.join("9:5", "Bravo", vi.fn(), vi.fn());

    const channels = await app.inject({ method: "GET", url: "/api/channels" });
    expect(channels.json()).toEqual({ open: { "3": 1 } });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toEqual({ ok: true, rooms: 2, peers: 2 });
  });
});

describe("groups API", () => {
  const stage = {
    name: "Stage",
    channels: [
      { channel: 1, code: 0, label: "musicians" },
      { channel: 2, code: 0, label: "led-tech" },
    ],
  };

  async function createGroup(app: FastifyInstance) {
    const res = await app.inject({ method: "POST", url: "/api/groups", payload: stage });
    expect(res.statusCode).toBe(200);
    return res.json() as { groupId: string; adminKey: string; name: string };
  }

  it("creates a group and serves its lobby info", async () => {
    const { app } = await makeApp();
    const created = await createGroup(app);
    expect(created.name).toBe("Stage");

    const info = await app.inject({ method: "GET", url: `/api/groups/${created.groupId}` });
    expect(info.statusCode).toBe(200);
    const body = info.json() as { channels: Array<{ label: string; occupancy: number }> };
    expect(body.channels.map((c) => c.label)).toEqual(["musicians", "led-tech"]);
  });

  it("rejects invalid group definitions", async () => {
    const { app } = await makeApp();
    for (const payload of [
      { ...stage, channels: [stage.channels[0]] }, // below min
      { ...stage, channels: [stage.channels[0], stage.channels[0]] }, // duplicate pair
      { ...stage, name: "x" },
      { name: "Stage" },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/groups", payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("404s lobby and join for unknown groups", async () => {
    const { app } = await makeApp();
    const info = await app.inject({ method: "GET", url: "/api/groups/nope1234" });
    expect(info.statusCode).toBe(404);
    const join = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { channel: 1, code: 0, callsign: "Alpha", groupId: "nope1234" },
    });
    expect(join.statusCode).toBe(404);
  });

  it("rejects joining a channel the group does not contain", async () => {
    const { app } = await makeApp();
    const created = await createGroup(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { channel: 9, code: 9, callsign: "Alpha", groupId: created.groupId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "channel-not-in-group" });
  });

  it("issues member tokens for group channels", async () => {
    const { app } = await makeApp();
    const created = await createGroup(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/join",
      payload: { channel: 1, code: 0, callsign: "Alpha", groupId: created.groupId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("token");
  });

  it("guards announce with the admin key", async () => {
    const { app } = await makeApp();
    const created = await createGroup(app);
    const bad = await app.inject({
      method: "POST",
      url: `/api/groups/${created.groupId}/announce`,
      payload: { adminKey: "0".repeat(32), callsign: "Ops" },
    });
    expect(bad.statusCode).toBe(403);

    const good = await app.inject({
      method: "POST",
      url: `/api/groups/${created.groupId}/announce`,
      payload: { adminKey: created.adminKey, callsign: "Ops" },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toHaveProperty("token");
  });

  it("refuses announce when the group exceeds the member cap", async () => {
    const { app, roomManager } = await makeApp({ maxGroupMembers: 1 });
    const created = await createGroup(app);
    roomManager.join(`g/${created.groupId}/1:0`, "One", vi.fn(), vi.fn());
    roomManager.join(`g/${created.groupId}/2:0`, "Two", vi.fn(), vi.fn());
    const res = await app.inject({
      method: "POST",
      url: `/api/groups/${created.groupId}/announce`,
      payload: { adminKey: created.adminKey, callsign: "Ops" },
    });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toEqual({ error: "group-too-large" });
  });
});

describe("static client serving", () => {
  it("serves files created after boot and falls back to index.html for SPA routes", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dist = mkdtempSync(join(tmpdir(), "wt-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
    const { app } = await makeApp({ clientDist: dist });

    // Simulate a rebuild under a running server: a new hashed asset appears.
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "index-NEWHASH.js"), "export {};");

    const asset = await app.inject({ method: "GET", url: "/assets/index-NEWHASH.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");

    const spa = await app.inject({ method: "GET", url: "/some/client/route" });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers["content-type"]).toContain("text/html");

    const api404 = await app.inject({ method: "GET", url: "/api/nope" });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toEqual({ error: "not-found" });
  });
});

describe("config validation", () => {
  it("rejects partial TURN configuration", () => {
    expect(() => loadConfig({ TURN_URL: "turn:x" })).toThrow(/together/);
  });

  it("rejects a short SESSION_SECRET", () => {
    expect(() => loadConfig({ SESSION_SECRET: "short" })).toThrow();
  });

  it("treats empty-string env values as unset (dotenv NAME= style)", () => {
    const config = loadConfig({ SESSION_SECRET: "", TURN_URL: "", CLIENT_DIST: "" });
    expect(config.sessionSecretGenerated).toBe(true);
    expect(config.turn).toBeNull();
    expect(config.clientDist).toBeNull();
  });

  it("does not trust proxy headers unless opted in", () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
  });
});
