import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { serverMessageSchema, type ServerMessage } from "@walkietalkie/shared";
import { buildApp } from "../src/app.js";
import { GroupRegistry, groupWsDeps } from "../src/groups.js";
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
  const groups = new GroupRegistry((key) => roomManager.sizeOf(key));
  app = await buildApp({ config, tokens, roomManager, groups });
  attachWebSocket(app.server, {
    tokens,
    roomManager,
    ...groupWsDeps(groups, roomManager),
    log: { info: () => undefined, warn: () => undefined },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

describe("group announce end-to-end", () => {
  const stage = {
    name: "Stage",
    channels: [
      { channel: 1, code: 5, label: "musicians" },
      { channel: 2, code: 5, label: "led-tech" },
    ],
  };

  async function createGroup(): Promise<{ groupId: string; adminKey: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stage),
    });
    if (!res.ok) throw new Error(`group create failed: ${res.status}`);
    return (await res.json()) as { groupId: string; adminKey: string };
  }

  async function joinGroupChannel(
    groupId: string,
    channel: number,
    callsign: string,
  ): Promise<Radio> {
    const res = await fetch(`http://127.0.0.1:${port}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, code: 5, callsign, groupId }),
    });
    if (!res.ok) throw new Error(`group join failed: ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    return connect(token);
  }

  async function connectAnnouncer(
    groupId: string,
    adminKey: string,
    callsign: string,
  ): Promise<Radio> {
    const res = await fetch(`http://127.0.0.1:${port}/api/groups/${groupId}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminKey, callsign }),
    });
    if (!res.ok) throw new Error(`announce token failed: ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    return connect(token);
  }

  it("runs the full announce flow across two isolated channels", async () => {
    const { groupId, adminKey } = await createGroup();

    // Two members on DIFFERENT channels of the group.
    const musician = await joinGroupChannel(groupId, 1, "Guitar");
    const tech = await joinGroupChannel(groupId, 2, "Lights");
    const wM = await musician.nextOfType("welcome");
    const wT = await tech.nextOfType("welcome");
    // Channel isolation inside the group: they don't see each other.
    expect(wM.peers).toHaveLength(0);
    expect(wT.peers).toHaveLength(0);

    // Group rooms are isolated from the global FRS room of the same number.
    const globalPeer = await joinAndConnect("Outsider", 1, 5);
    const wG = await globalPeer.nextOfType("welcome");
    expect(wG.peers).toHaveLength(0);

    // Announcer joins everything at once.
    const ops = await connectAnnouncer(groupId, adminKey, "Ops");
    const wOps = await ops.nextOfType("welcome");
    expect(wOps.self.status).toBe("announcing");
    expect(wOps.peers.map((p) => p.callsign).sort()).toEqual(["Guitar", "Lights"]);
    // Both members see the announcer arrive in their own room.
    expect((await musician.nextOfType("peer-joined")).peer.callsign).toBe("Ops");
    expect((await tech.nextOfType("peer-joined")).peer.callsign).toBe("Ops");
    // Cross-room politeness: group-wide joinSeq is a total order.
    expect(wOps.self.joinSeq).toBeGreaterThan(wM.self.joinSeq);

    // Atomic group floor: both channels grant to the announcer.
    ops.send({ t: "request-group-floor" });
    await ops.nextOfType("group-floor-granted");
    expect((await musician.nextOfType("floor-granted")).holder).toBe(wOps.self.peerId);
    expect((await tech.nextOfType("floor-granted")).holder).toBe(wOps.self.peerId);

    // Members cannot key over the announcement.
    musician.send({ t: "request-floor" });
    expect((await musician.nextOfType("floor-denied")).reason).toBe("busy");

    // Signal relay reaches a member in whichever room they sit.
    ops.send({ t: "signal", to: wM.self.peerId, data: { sdp: "announce-offer" } });
    const relayed = await musician.nextOfType("signal");
    expect(relayed.from).toBe(wOps.self.peerId);

    // Release frees every channel.
    ops.send({ t: "release-group-floor" });
    await ops.nextOfType("group-floor-released");
    expect((await musician.nextOfType("floor-released")).reason).toBe("released");
    expect((await tech.nextOfType("floor-released")).reason).toBe("released");

    // A member can talk again afterwards.
    musician.send({ t: "request-floor" });
    await musician.nextOfType("floor-granted");
    musician.send({ t: "release-floor" });

    musician.ws.close();
    tech.ws.close();
    globalPeer.ws.close();
    ops.ws.close();
  });

  it("denies the group floor atomically while any channel is busy", async () => {
    const { groupId, adminKey } = await createGroup();
    const talker = await joinGroupChannel(groupId, 1, "Talker");
    const listener = await joinGroupChannel(groupId, 2, "Listener");
    await talker.nextOfType("welcome");
    await listener.nextOfType("welcome");

    talker.send({ t: "request-floor" });
    await talker.nextOfType("floor-granted");

    const ops = await connectAnnouncer(groupId, adminKey, "Boss");
    await ops.nextOfType("welcome");
    await talker.nextOfType("peer-joined");
    await listener.nextOfType("peer-joined");

    ops.send({ t: "request-group-floor" });
    const denied = await ops.nextOfType("group-floor-denied");
    expect(denied.busy).toEqual(["musicians"]);
    // The untouched channel saw a rollback, never a lasting grant: the
    // listener's next floor event must be a release (from the rollback) or
    // nothing held — proven by the listener acquiring the floor right now.
    listener.send({ t: "request-floor" });
    await listener.nextOfType("floor-granted");

    // Members' floor events are suppressed for the announcer, who still
    // gets pong (session alive).
    ops.send({ t: "ping" });
    await ops.nextOfType("pong");

    // Member-mode messages on an announce socket earn an error frame.
    ops.send({ t: "request-floor" });
    expect((await ops.nextOfType("error")).code).toBe("announce-session");
    // And vice versa.
    talker.send({ t: "request-group-floor" });
    expect((await talker.nextOfType("error")).code).toBe("not-announce-session");

    talker.ws.close();
    listener.ws.close();
    ops.ws.close();
  });

  it("releases every channel when the announcer disconnects mid-announcement", async () => {
    const { groupId, adminKey } = await createGroup();
    const member = await joinGroupChannel(groupId, 1, "Solo");
    await member.nextOfType("welcome");

    const ops = await connectAnnouncer(groupId, adminKey, "Ghost");
    await ops.nextOfType("welcome");
    await member.nextOfType("peer-joined");

    ops.send({ t: "request-group-floor" });
    await ops.nextOfType("group-floor-granted");
    await member.nextOfType("floor-granted");

    ops.ws.close();
    expect((await member.nextOfType("floor-released")).reason).toBe("disconnected");
    await member.nextOfType("peer-left");

    member.send({ t: "request-floor" });
    await member.nextOfType("floor-granted");
    member.ws.close();
  });
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

  it("closes 4400 when a member claims the reserved announcing status", async () => {
    const radio = await joinAndConnect("Faker", 15, 1);
    await radio.nextOfType("welcome");
    radio.send({ t: "set-status", status: "announcing" }); // known type, invalid payload
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

  it("closes 4429 when a socket floods past the message budget", async () => {
    const radio = await joinAndConnect("Lima", 13, 1);
    await radio.nextOfType("welcome");
    // Capacity is 200 with 50/s refill — 260 instant frames must trip it.
    for (let i = 0; i < 260; i++) {
      radio.send({ t: "ping" });
    }
    const { code } = await radio.closed;
    expect(code).toBe(4429);
    // The server itself is unaffected.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.ok).toBe(true);
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
