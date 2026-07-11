import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { serverMessageSchema, type ServerMessage } from "@walkietalkie/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RoomManager } from "../src/rooms.js";
import { TokenService } from "../src/tokens.js";
import { attachWebSocket } from "../src/ws.js";

let app: FastifyInstance;
let port: number;

/** Buffered reader over a socket's incoming server frames. */
class Radio {
  private queue: ServerMessage[] = [];
  private waiters: Array<(msg: ServerMessage) => void> = [];
  readonly closed: Promise<{ code: number }>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) throw new Error(`unparseable server frame: ${String(raw)}`);
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed.data);
      else this.queue.push(parsed.data);
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code) => resolve({ code }));
    });
  }

  async next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async nextOfType<T extends ServerMessage["t"]>(
    type: T,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    for (let i = 0; i < 10; i++) {
      const msg = await this.next();
      if (msg.t === type) return msg as Extract<ServerMessage, { t: T }>;
    }
    throw new Error(`no ${type} frame within 10 messages`);
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: 1, ...msg }));
  }
}

async function joinToken(callsign: string, channel = 3, code = 7): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, code, callsign }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function connect(token: string): Promise<Radio> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(new Radio(ws)));
    ws.on("error", reject);
  });
}

async function joinAndConnect(callsign: string, channel = 3, code = 7): Promise<Radio> {
  return connect(await joinToken(callsign, channel, code));
}

beforeAll(async () => {
  const config = loadConfig({ LOG_LEVEL: "error", JOIN_RATE_MAX: "1000" });
  const tokens = new TokenService(config.sessionSecret);
  const roomManager = new RoomManager({
    maxChannelSize: config.maxChannelSize,
    cooldownMs: 0,
  });
  app = await buildApp({ config, tokens, roomManager });
  attachWebSocket(app.server, {
    tokens,
    roomManager,
    log: { info: () => undefined, warn: () => undefined },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

describe("signaling end-to-end", () => {
  it("welcomes the joiner and notifies incumbents", async () => {
    const a = await joinAndConnect("Alpha", 1, 1);
    const welcomeA = await a.nextOfType("welcome");
    expect(welcomeA.self.callsign).toBe("Alpha");
    expect(welcomeA.peers).toHaveLength(0);

    const b = await joinAndConnect("Bravo", 1, 1);
    const welcomeB = await b.nextOfType("welcome");
    expect(welcomeB.peers.map((p) => p.callsign)).toEqual(["Alpha"]);

    const joined = await a.nextOfType("peer-joined");
    expect(joined.peer.callsign).toBe("Bravo");

    a.ws.close();
    b.ws.close();
  });

  it("runs the full floor cycle: grant → busy-deny → release → regrant", async () => {
    const a = await joinAndConnect("Alpha", 2, 1);
    const b = await joinAndConnect("Bravo", 2, 1);
    const selfA = (await a.nextOfType("welcome")).self;
    await b.nextOfType("welcome");
    await a.nextOfType("peer-joined");

    a.send({ t: "request-floor" });
    const grantA = await a.nextOfType("floor-granted");
    expect(grantA.holder).toBe(selfA.peerId);
    await b.nextOfType("floor-granted");

    b.send({ t: "request-floor" });
    const denied = await b.nextOfType("floor-denied");
    expect(denied.reason).toBe("busy");
    expect(denied.holder).toBe(selfA.peerId);

    a.send({ t: "release-floor" });
    const released = await b.nextOfType("floor-released");
    expect(released.reason).toBe("released");
    expect(released.seq).toBeGreaterThan(grantA.seq);

    b.send({ t: "request-floor" });
    const grantB = await b.nextOfType("floor-granted");
    expect(grantB.holder).not.toBe(selfA.peerId);

    a.ws.close();
    b.ws.close();
  });

  it("relays signal payloads and errors on unknown peers", async () => {
    const a = await joinAndConnect("Alpha", 4, 1);
    const b = await joinAndConnect("Bravo", 4, 1);
    const selfA = (await a.nextOfType("welcome")).self;
    const welcomeB = await b.nextOfType("welcome");
    await a.nextOfType("peer-joined");

    const peerA = welcomeB.peers[0];
    if (!peerA) throw new Error("Bravo cannot see Alpha");
    b.send({ t: "signal", to: peerA.peerId, data: { sdp: "fake-offer" } });
    const relayed = await a.nextOfType("signal");
    expect(relayed.from).not.toBe(selfA.peerId);
    expect(relayed.data).toEqual({ sdp: "fake-offer" });

    b.send({ t: "signal", to: "nonexistent", data: {} });
    const err = await b.nextOfType("error");
    expect(err.code).toBe("unknown-peer");

    a.ws.close();
    b.ws.close();
  });

  it("releases the floor when the holder disconnects", async () => {
    const a = await joinAndConnect("Alpha", 5, 1);
    const b = await joinAndConnect("Bravo", 5, 1);
    await a.nextOfType("welcome");
    await b.nextOfType("welcome");
    await a.nextOfType("peer-joined");

    a.send({ t: "request-floor" });
    await b.nextOfType("floor-granted");
    a.ws.close();

    const released = await b.nextOfType("floor-released");
    expect(released.reason).toBe("disconnected");
    await b.nextOfType("peer-left");
    b.ws.close();
  });

  it("closes 4401 on an invalid token and on token reuse", async () => {
    const bogus = new WebSocket(`ws://127.0.0.1:${port}/ws?token=garbage`);
    const bogusClose = await new Promise<number>((resolve) => {
      bogus.on("close", (code) => resolve(code));
    });
    expect(bogusClose).toBe(4401);

    const token = await joinToken("Echo", 6, 1);
    const first = await connect(token);
    await first.nextOfType("welcome");
    const second = await connect(token);
    const { code } = await second.closed;
    expect(code).toBe(4401);
    first.ws.close();
  });

  it("closes 4409 when two admitted sockets collide on callsign", async () => {
    const t1 = await joinToken("Foxtrot", 7, 1);
    const t2 = await joinToken("foxtrot", 7, 1); // passes pre-check: room empty at issue
    const first = await connect(t1);
    await first.nextOfType("welcome");
    const second = await connect(t2);
    const { code } = await second.closed;
    expect(code).toBe(4409);
    first.ws.close();
  });

  it("closes 4400 on malformed frames", async () => {
    const radio = await joinAndConnect("Golf", 8, 1);
    await radio.nextOfType("welcome");
    radio.ws.send("not json at all");
    const { code } = await radio.closed;
    expect(code).toBe(4400);
  });

  it("closes 4400 on a known type with an invalid payload", async () => {
    const radio = await joinAndConnect("India", 10, 1);
    await radio.nextOfType("welcome");
    radio.send({ t: "signal", to: "" }); // known type, fails schema
    const { code } = await radio.closed;
    expect(code).toBe(4400);
  });

  it("answers unknown message types with an error frame, socket stays open", async () => {
    const radio = await joinAndConnect("Juliet", 11, 1);
    await radio.nextOfType("welcome");
    radio.send({ t: "from-the-future" });
    const err = await radio.nextOfType("error");
    expect(err.code).toBe("unknown-type");
    // The session is still healthy afterwards.
    radio.send({ t: "ping" });
    await radio.nextOfType("pong");
    radio.ws.close();
  });

  it("survives an oversized frame: that socket dies, the server does not", async () => {
    const radio = await joinAndConnect("Kilo", 12, 1);
    await radio.nextOfType("welcome");
    radio.ws.send("x".repeat(40 * 1024)); // over the 32 KiB maxPayload
    await radio.closed;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.ok).toBe(true);
  });

  it("answers application-level ping with pong", async () => {
    const radio = await joinAndConnect("Hotel", 9, 1);
    await radio.nextOfType("welcome");
    radio.send({ t: "ping" });
    await radio.nextOfType("pong");
    radio.ws.close();
  });
});
