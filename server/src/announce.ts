import { randomUUID } from "node:crypto";
import {
  MAX_HOLD_MS,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@walkietalkie/shared";
import type { Room, RoomManager } from "./rooms.js";

/**
 * One announce (PA) session: a single admin socket admitted into every
 * channel of a group. Transmit-only by design — members just see a normal
 * transmitter key up in their room; the announcer receives no per-room
 * floor noise, only group-floor-* results.
 */

export interface AnnounceDeps {
  roomManager: RoomManager;
  /** Group-wide joinSeq so cross-room politeness stays a total order. */
  nextJoinSeq: () => number;
  /** roomKey → human label, for deny messages ("musicians busy"). */
  labelOf: (roomKey: string) => string;
}

export type AnnounceAdmission =
  | { ok: true; session: AnnounceSession }
  | { ok: false; code: "full" | "callsign-taken" };

export class AnnounceSession {
  readonly peerId = randomUUID();
  private joined: Array<{ room: Room }> = [];
  private holding = false;
  /** Hooks are a single slot per room — only ever disarm what WE armed. */
  private hooksArmed = false;

  private constructor(
    private readonly deps: AnnounceDeps,
    private readonly sendToAnnouncer: (msg: ServerMessage) => void,
    private readonly closeSocket: (code: number, reason: string) => void,
  ) {}

  static admit(
    roomKeys: string[],
    callsign: string,
    deps: AnnounceDeps,
    sendToAnnouncer: (msg: ServerMessage) => void,
    closeSocket: (code: number, reason: string) => void,
  ): AnnounceAdmission {
    const session = new AnnounceSession(deps, sendToAnnouncer, closeSocket);
    const joinSeq = deps.nextJoinSeq();

    for (const key of roomKeys) {
      const result = deps.roomManager.join(
        key,
        callsign,
        (msg) => session.relayToAnnouncer(msg),
        closeSocket,
        { peerId: session.peerId, joinSeq, status: "announcing" },
      );
      if (!result.ok) {
        session.leaveAll();
        return { ok: false, code: result.code };
      }
      session.joined.push({ room: result.room });
    }
    return { ok: true, session };
  }

  /** Merged welcome across every joined room. */
  welcome(): ServerMessage {
    const first = this.joined[0];
    const self = first?.room.getPeer(this.peerId)?.peer;
    if (self === undefined) {
      throw new Error("announce session welcomed before any room joined");
    }
    return {
      t: "welcome",
      v: PROTOCOL_VERSION,
      self,
      peers: this.joined.flatMap(({ room }) =>
        room.peerList.filter((p) => p.peerId !== this.peerId),
      ),
      floor: { holder: null },
      seq: 0,
    };
  }

  /**
   * Atomic group floor: every channel free, or none is taken. Two-phase so
   * atomicity is invisible to members — floors are acquired silently first;
   * grants broadcast only once EVERY channel said yes. A partial acquisition
   * rolls back before any member ever saw a frame.
   */
  requestFloor(): void {
    if (this.holding) {
      return;
    }
    const granted: Array<{ room: Room; seq: number }> = [];
    const busy: string[] = [];
    let maxHoldMs = MAX_HOLD_MS;

    for (const { room } of this.joined) {
      const result = room.floor.request(this.peerId);
      if (result.ok) {
        maxHoldMs = result.maxHoldMs;
        granted.push({ room, seq: result.seq });
      } else {
        busy.push(this.deps.labelOf(room.key));
      }
    }

    if (busy.length > 0) {
      for (const { room } of granted) {
        // disconnect() releases without cooldown; nothing was broadcast, so
        // members never saw the aborted acquisition at all.
        room.floor.disconnect(this.peerId);
      }
      this.sendToAnnouncer({ t: "group-floor-denied", v: PROTOCOL_VERSION, busy });
      return;
    }

    this.holding = true;
    this.hooksArmed = true;
    for (const { room, seq } of granted) {
      room.onFloorForceRelease = (holder) => {
        if (holder === this.peerId) {
          this.endHold("timeout");
        }
      };
      room.broadcast({
        t: "floor-granted",
        v: PROTOCOL_VERSION,
        holder: this.peerId,
        seq,
        maxHoldMs,
      });
    }
    this.sendToAnnouncer({ t: "group-floor-granted", v: PROTOCOL_VERSION, maxHoldMs });
  }

  releaseFloor(): void {
    this.endHold("released");
  }

  /** Route an opaque signal to whichever room holds the target peer. */
  relaySignal(to: string, data: Record<string, unknown>): boolean {
    for (const { room } of this.joined) {
      if (room.sendTo(to, { t: "signal", v: PROTOCOL_VERSION, from: this.peerId, data })) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.disarmHooks();
    this.holding = false;
    this.leaveAll();
  }

  private endHold(reason: "released" | "timeout"): void {
    if (!this.holding) {
      return;
    }
    this.holding = false;
    this.disarmHooks();
    for (const { room } of this.joined) {
      const released = room.floor.release(this.peerId);
      if (released.released) {
        room.broadcast({
          t: "floor-released",
          v: PROTOCOL_VERSION,
          seq: released.seq,
          reason: "released",
        });
      }
    }
    this.sendToAnnouncer({ t: "group-floor-released", v: PROTOCOL_VERSION, reason });
  }

  /** Per-room floor/status noise never reaches the announcer. */
  private relayToAnnouncer(msg: ServerMessage): void {
    switch (msg.t) {
      case "floor-granted":
      case "floor-denied":
      case "floor-released":
      case "status-changed":
        return;
      default:
        this.sendToAnnouncer(msg);
    }
  }

  private disarmHooks(): void {
    if (!this.hooksArmed) {
      return; // another session's hooks may be armed — never clobber them
    }
    this.hooksArmed = false;
    for (const { room } of this.joined) {
      room.onFloorForceRelease = null;
    }
  }

  private leaveAll(): void {
    for (const { room } of this.joined) {
      this.deps.roomManager.leave(room.key, this.peerId);
    }
    this.joined = [];
  }
}
