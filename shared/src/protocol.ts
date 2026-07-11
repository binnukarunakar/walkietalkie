import { z } from "zod";
import { CHANNEL_MAX, CHANNEL_MIN, CODE_MAX, CODE_MIN } from "./frs.js";

export const PROTOCOL_VERSION = 1;

/** Floor-control tuning. */
export const MAX_HOLD_MS = 60_000;
export const RELEASE_COOLDOWN_MS = 250;

/** Room limits. */
export const DEFAULT_MAX_CHANNEL_SIZE = 9;

export const CALLSIGN_MIN = 2;
export const CALLSIGN_MAX = 16;
export const CALLSIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

export const peerStatusSchema = z.enum(["available", "busy", "monitoring"]);
export type PeerStatus = z.infer<typeof peerStatusSchema>;

export const callsignSchema = z
  .string()
  .trim()
  .min(CALLSIGN_MIN)
  .max(CALLSIGN_MAX)
  .regex(CALLSIGN_PATTERN, "letters, digits, space, _ or - only");

export const joinRequestSchema = z.object({
  channel: z.number().int().min(CHANNEL_MIN).max(CHANNEL_MAX),
  code: z.number().int().min(CODE_MIN).max(CODE_MAX),
  callsign: callsignSchema,
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

export interface Peer {
  peerId: string;
  callsign: string;
  status: PeerStatus;
  joinSeq: number;
}

export interface FloorState {
  holder: string | null;
  since?: number | undefined;
}

/** Opaque SDP/ICE payload — relayed, never inspected by the server. */
const signalDataSchema = z.object({}).catchall(z.unknown());

// ── client → server ──────────────────────────────────────────────────────────

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("request-floor"), v: z.literal(PROTOCOL_VERSION) }),
  z.object({ t: z.literal("release-floor"), v: z.literal(PROTOCOL_VERSION) }),
  z.object({
    t: z.literal("signal"),
    v: z.literal(PROTOCOL_VERSION),
    to: z.string().min(1).max(64),
    data: signalDataSchema,
  }),
  z.object({
    t: z.literal("set-status"),
    v: z.literal(PROTOCOL_VERSION),
    status: peerStatusSchema,
  }),
  z.object({ t: z.literal("ping"), v: z.literal(PROTOCOL_VERSION) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── server → client ──────────────────────────────────────────────────────────

export type FloorDenyReason = "busy" | "cooldown";
export type FloorReleaseReason = "released" | "timeout" | "disconnected";

export type ServerMessage =
  | {
      t: "welcome";
      v: typeof PROTOCOL_VERSION;
      self: Peer;
      peers: Peer[];
      floor: FloorState;
      seq: number;
    }
  | { t: "peer-joined"; v: typeof PROTOCOL_VERSION; peer: Peer }
  | { t: "peer-left"; v: typeof PROTOCOL_VERSION; peerId: string }
  | {
      t: "floor-granted";
      v: typeof PROTOCOL_VERSION;
      holder: string;
      seq: number;
      maxHoldMs: number;
    }
  | {
      t: "floor-denied";
      v: typeof PROTOCOL_VERSION;
      reason: FloorDenyReason;
      holder?: string | undefined;
    }
  | {
      t: "floor-released";
      v: typeof PROTOCOL_VERSION;
      seq: number;
      reason: FloorReleaseReason;
    }
  | { t: "signal"; v: typeof PROTOCOL_VERSION; from: string; data: Record<string, unknown> }
  | { t: "status-changed"; v: typeof PROTOCOL_VERSION; peerId: string; status: PeerStatus }
  | { t: "pong"; v: typeof PROTOCOL_VERSION }
  | { t: "error"; v: typeof PROTOCOL_VERSION; code: string; message: string };

/** Runtime validator for the client side (server frames are still untrusted input). */
export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    v: z.literal(PROTOCOL_VERSION),
    self: z.object({
      peerId: z.string(),
      callsign: z.string(),
      status: peerStatusSchema,
      joinSeq: z.number().int(),
    }),
    peers: z.array(
      z.object({
        peerId: z.string(),
        callsign: z.string(),
        status: peerStatusSchema,
        joinSeq: z.number().int(),
      }),
    ),
    floor: z.object({
      holder: z.string().nullable(),
      since: z.number().optional(),
    }),
    seq: z.number().int(),
  }),
  z.object({
    t: z.literal("peer-joined"),
    v: z.literal(PROTOCOL_VERSION),
    peer: z.object({
      peerId: z.string(),
      callsign: z.string(),
      status: peerStatusSchema,
      joinSeq: z.number().int(),
    }),
  }),
  z.object({ t: z.literal("peer-left"), v: z.literal(PROTOCOL_VERSION), peerId: z.string() }),
  z.object({
    t: z.literal("floor-granted"),
    v: z.literal(PROTOCOL_VERSION),
    holder: z.string(),
    seq: z.number().int(),
    maxHoldMs: z.number().int(),
  }),
  z.object({
    t: z.literal("floor-denied"),
    v: z.literal(PROTOCOL_VERSION),
    reason: z.enum(["busy", "cooldown"]),
    holder: z.string().optional(),
  }),
  z.object({
    t: z.literal("floor-released"),
    v: z.literal(PROTOCOL_VERSION),
    seq: z.number().int(),
    reason: z.enum(["released", "timeout", "disconnected"]),
  }),
  z.object({
    t: z.literal("signal"),
    v: z.literal(PROTOCOL_VERSION),
    from: z.string(),
    data: signalDataSchema,
  }),
  z.object({
    t: z.literal("status-changed"),
    v: z.literal(PROTOCOL_VERSION),
    peerId: z.string(),
    status: peerStatusSchema,
  }),
  z.object({ t: z.literal("pong"), v: z.literal(PROTOCOL_VERSION) }),
  z.object({
    t: z.literal("error"),
    v: z.literal(PROTOCOL_VERSION),
    code: z.string(),
    message: z.string(),
  }),
]);
