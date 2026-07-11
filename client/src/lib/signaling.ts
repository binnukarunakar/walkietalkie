import {
  PROTOCOL_VERSION,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "@walkietalkie/shared";
import { CLOSE_LIVENESS_TIMEOUT } from "./reconnect";

export interface SignalingCallbacks {
  onMessage: (msg: ServerMessage) => void;
  /** Fired on unexpected drop of an ESTABLISHED socket. Pre-open failures reject connect() instead. */
  onDrop: (closeCode: number) => void;
}

const APP_PING_INTERVAL_MS = 25_000;
/** No server frame for this long ⇒ half-open socket; force a reconnect. */
const LIVENESS_TIMEOUT_MS = APP_PING_INTERVAL_MS * 2 + 5_000;

/**
 * Thin WebSocket wrapper: token handshake, frame validation, app-level
 * keepalive + liveness. Reconnection policy lives in RadioClient, not here.
 */
export class Signaling {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private intentionalClose = false;
  private lastServerFrameAt = 0;

  constructor(private readonly callbacks: SignalingCallbacks) {}

  async connect(token: string): Promise<void> {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
    this.intentionalClose = false;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.lastServerFrameAt = Date.now();
        this.pingTimer = window.setInterval(() => {
          // Half-open TCP (sleep/NAT rebind) never delivers onclose; detect
          // the silence ourselves and close so the reconnect path kicks in.
          if (Date.now() - this.lastServerFrameAt > LIVENESS_TIMEOUT_MS) {
            ws.close(CLOSE_LIVENESS_TIMEOUT, "liveness timeout");
            return;
          }
          this.send({ t: "ping", v: PROTOCOL_VERSION });
        }, APP_PING_INTERVAL_MS);
        resolve();
      };

      ws.onmessage = (event) => {
        this.lastServerFrameAt = Date.now();
        let json: unknown;
        try {
          json = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = serverMessageSchema.safeParse(json);
        if (parsed.success) {
          this.callbacks.onMessage(parsed.data);
        }
      };

      ws.onclose = (event) => {
        this.cleanup();
        // Exactly one failure path per socket: pre-open failures reject the
        // connect() promise; established-socket drops fire onDrop. Firing
        // both forked the reconnect loop into parallel timer chains.
        if (!opened) {
          reject(new Error(`socket closed (${String(event.code)})`));
          return;
        }
        if (!this.intentionalClose) {
          this.callbacks.onDrop(event.code);
        }
      };

      ws.onerror = () => {
        // onclose always follows; nothing to do here.
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.ws?.close(1000, "leaving");
    this.ws = null;
  }

  /** Test/diagnostic hook: sever the socket as if the network dropped. */
  dropForTest(): void {
    this.ws?.close(CLOSE_LIVENESS_TIMEOUT, "test drop");
  }

  private cleanup(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export class JoinError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`join rejected: ${code} (${String(status)})`);
  }
}

export async function requestJoinToken(
  channel: number,
  code: number,
  callsign: string,
): Promise<string> {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, code, callsign }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "unknown" }))) as { error?: string };
    throw new JoinError(res.status, body.error ?? "unknown");
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch("/api/ice");
    if (!res.ok) {
      return DEFAULT_ICE;
    }
    const body = (await res.json()) as { iceServers?: unknown };
    const servers = validateIceServers(body.iceServers);
    return servers.length > 0 ? servers : DEFAULT_ICE;
  } catch {
    return DEFAULT_ICE;
  }
}

/** A proxy error page served as 200-JSON must not crash RTCPeerConnection. */
function validateIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: RTCIceServer[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { urls, username, credential } = entry as Record<string, unknown>;
    const urlsValid =
      typeof urls === "string" ||
      (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === "string"));
    if (!urlsValid) continue;
    const server: RTCIceServer = { urls: urls as string | string[] };
    if (typeof username === "string") server.username = username;
    if (typeof credential === "string") server.credential = credential;
    out.push(server);
  }
  return out;
}
