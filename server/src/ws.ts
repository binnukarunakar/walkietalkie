import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "@walkietalkie/shared";
import { AnnounceSession, type AnnounceDeps } from "./announce.js";
import type { RoomManager, Room, PeerHandle } from "./rooms.js";
import type { SessionClaims, TokenService } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 32 * 1024;

/** WS close codes (4xxx = application-defined). */
export const WS_CLOSE = {
  invalidToken: 4401,
  callsignTaken: 4409,
  channelFull: 4423,
  protocolError: 4400,
  rateLimited: 4429,
} as const;

/**
 * Per-socket message budget. Sized so a joiner renegotiating a full 9-peer
 * mesh (offers/answers/ICE bursts) never comes close, while a flood gets the
 * socket closed instead of the room's CPU.
 */
export const MSG_BUCKET_CAPACITY = 200;
export const MSG_BUCKET_REFILL_PER_SEC = 50;

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  take(): boolean {
    const current = this.now();
    const elapsedSec = (current - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = current;
    }
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

interface LiveSocket extends WebSocket {
  isAlive?: boolean;
}

export interface WsDeps {
  tokens: TokenService;
  roomManager: RoomManager;
  /** Wires announce sessions to the group registry (seq + labels). */
  announceDeps: (groupId: string | undefined) => AnnounceDeps;
  /** joinSeq for MEMBERS of group rooms (shared per-group counter). */
  memberJoinSeq: (groupId: string | undefined) => number | undefined;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

export function attachWebSocket(server: Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req, socket, head) => {
    if (pathnameOf(req) !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: LiveSocket, req: IncomingMessage) => {
    void admit(ws, req, deps);
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<LiveSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

async function admit(ws: LiveSocket, req: IncomingMessage, deps: WsDeps): Promise<void> {
  // Without a listener, a socket-level error (invalid UTF-8, payload over
  // maxPayload, TCP reset) is an uncaught exception that kills the process.
  ws.on("error", (err) => {
    deps.log.warn(`websocket error: ${err.message}`);
  });

  const url = new URL(req.url ?? "/", "http://internal");
  const token = url.searchParams.get("token");
  const claims = token === null ? null : await deps.tokens.verifyAndConsume(token);
  if (claims === null) {
    ws.close(WS_CLOSE.invalidToken, "invalid or expired token");
    return;
  }
  if (claims.mode === "announce") {
    admitAnnounce(ws, claims, deps);
  } else {
    admitMember(ws, claims, deps);
  }
}

function admitMember(ws: LiveSocket, claims: SessionClaims, deps: WsDeps): void {
  const roomKey = claims.rooms[0];
  if (roomKey === undefined) {
    ws.close(WS_CLOSE.invalidToken, "no room in token");
    return;
  }
  const joinSeq = deps.memberJoinSeq(claims.group);
  const result = deps.roomManager.join(
    roomKey,
    claims.callsign,
    (msg) => sendJson(ws, msg),
    (code, reason) => ws.close(code, reason),
    joinSeq === undefined ? undefined : { joinSeq },
  );
  if (!result.ok) {
    ws.close(
      result.code === "full" ? WS_CLOSE.channelFull : WS_CLOSE.callsignTaken,
      result.code,
    );
    return;
  }

  const { room, handle } = result;
  deps.log.info(`peer ${handle.peer.callsign} joined ${room.key} (${String(room.size)} in room)`);

  handle.send({
    t: "welcome",
    v: PROTOCOL_VERSION,
    self: handle.peer,
    peers: room.peerList.filter((p) => p.peerId !== handle.peer.peerId),
    floor: room.floor.state,
    seq: room.floor.currentSeq,
  });

  wireSocket(ws, (msg) => dispatchMember(msg, room, handle), () => {
    deps.roomManager.leave(room.key, handle.peer.peerId);
    deps.log.info(`peer ${handle.peer.callsign} left ${room.key}`);
  });
}

function admitAnnounce(ws: LiveSocket, claims: SessionClaims, deps: WsDeps): void {
  const admission = AnnounceSession.admit(
    claims.rooms,
    claims.callsign,
    deps.announceDeps(claims.group),
    (msg) => sendJson(ws, msg),
    (code, reason) => ws.close(code, reason),
  );
  if (!admission.ok) {
    ws.close(
      admission.code === "full" ? WS_CLOSE.channelFull : WS_CLOSE.callsignTaken,
      admission.code,
    );
    return;
  }

  const { session } = admission;
  deps.log.info(`announce session ${claims.callsign} across ${String(claims.rooms.length)} rooms`);
  sendJson(ws, session.welcome());

  wireSocket(ws, (msg) => dispatchAnnounce(msg, session, ws), () => {
    session.dispose();
    deps.log.info(`announce session ${claims.callsign} ended`);
  });
}

/** Shared per-socket wiring: liveness flag, flood bucket, frame parsing. */
function wireSocket(ws: LiveSocket, onMessage: (msg: ClientMessage) => void, onClose: () => void): void {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const bucket = new TokenBucket(MSG_BUCKET_CAPACITY, MSG_BUCKET_REFILL_PER_SEC);
  ws.on("message", (raw) => {
    if (!bucket.take()) {
      ws.close(WS_CLOSE.rateLimited, "message rate exceeded");
      return;
    }
    const result = parseClientMessage(raw.toString());
    switch (result.kind) {
      case "ok":
        onMessage(result.msg);
        break;
      case "unknown-type":
        // Recoverable per PROTOCOL.md: a newer client speaking a message type
        // we don't know gets an error frame, not a teardown.
        sendJson(ws, {
          t: "error",
          v: PROTOCOL_VERSION,
          code: "unknown-type",
          message: `unsupported message type "${result.t}"`,
        });
        break;
      case "malformed":
        ws.close(WS_CLOSE.protocolError, "malformed frame");
        break;
    }
  });

  ws.on("close", onClose);

  // The socket may have died while token verification was in flight, i.e.
  // before the close listener above existed. Reap the ghost peer; a second
  // leave for the same peer is a no-op, so racing the listener is safe.
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    onClose();
  }
}

const KNOWN_CLIENT_TYPES: ReadonlySet<string> = new Set(
  clientMessageSchema.options.map((option) => option.shape.t.value),
);

type ParseResult =
  | { kind: "ok"; msg: ClientMessage }
  | { kind: "unknown-type"; t: string }
  | { kind: "malformed" };

/**
 * Three outcomes per PROTOCOL.md: valid frame; well-formed JSON with an
 * unrecognized `t` (recoverable — sender gets an `error` frame); anything
 * else, including a known `t` with an invalid payload (protocol error —
 * socket closes 4400).
 */
function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (parsed.success) {
    return { kind: "ok", msg: parsed.data };
  }
  if (typeof json === "object" && json !== null && "t" in json) {
    const t = (json as { t: unknown }).t;
    if (typeof t === "string" && !KNOWN_CLIENT_TYPES.has(t)) {
      return { kind: "unknown-type", t: t.slice(0, 64) };
    }
  }
  return { kind: "malformed" };
}

function dispatchMember(msg: ClientMessage, room: Room, handle: PeerHandle): void {
  const peerId = handle.peer.peerId;
  switch (msg.t) {
    case "request-floor": {
      const result = room.floor.request(peerId);
      if (result.ok) {
        room.broadcast({
          t: "floor-granted",
          v: PROTOCOL_VERSION,
          holder: peerId,
          seq: result.seq,
          maxHoldMs: result.maxHoldMs,
        });
      } else {
        const denied: ServerMessage = {
          t: "floor-denied",
          v: PROTOCOL_VERSION,
          reason: result.reason,
          ...(result.holder !== undefined ? { holder: result.holder } : {}),
        };
        handle.send(denied);
      }
      break;
    }
    case "release-floor": {
      const result = room.floor.release(peerId);
      if (result.released) {
        room.broadcast({
          t: "floor-released",
          v: PROTOCOL_VERSION,
          seq: result.seq,
          reason: "released",
        });
      }
      break;
    }
    case "signal": {
      const delivered = room.sendTo(msg.to, {
        t: "signal",
        v: PROTOCOL_VERSION,
        from: peerId,
        data: msg.data,
      });
      if (!delivered) {
        handle.send({
          t: "error",
          v: PROTOCOL_VERSION,
          code: "unknown-peer",
          message: `no peer ${msg.to} in room`,
        });
      }
      break;
    }
    case "set-status": {
      room.setStatus(peerId, msg.status);
      break;
    }
    case "ping": {
      handle.send({ t: "pong", v: PROTOCOL_VERSION });
      break;
    }
    case "request-group-floor":
    case "release-group-floor": {
      handle.send({
        t: "error",
        v: PROTOCOL_VERSION,
        code: "not-announce-session",
        message: "group floor is only available to announce sessions",
      });
      break;
    }
  }
}

function dispatchAnnounce(msg: ClientMessage, session: AnnounceSession, ws: LiveSocket): void {
  switch (msg.t) {
    case "request-group-floor":
      session.requestFloor();
      break;
    case "release-group-floor":
      session.releaseFloor();
      break;
    case "signal": {
      if (!session.relaySignal(msg.to, msg.data)) {
        sendJson(ws, {
          t: "error",
          v: PROTOCOL_VERSION,
          code: "unknown-peer",
          message: `no peer ${msg.to} in any group room`,
        });
      }
      break;
    }
    case "ping":
      sendJson(ws, { t: "pong", v: PROTOCOL_VERSION });
      break;
    case "request-floor":
    case "release-floor":
    case "set-status":
      sendJson(ws, {
        t: "error",
        v: PROTOCOL_VERSION,
        code: "announce-session",
        message: "announce sessions use the group floor",
      });
      break;
  }
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://internal").pathname;
}
