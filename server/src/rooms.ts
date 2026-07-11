import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Peer,
  type PeerStatus,
  type ServerMessage,
} from "@walkietalkie/shared";
import { FloorControl } from "./floor.js";

export interface PeerHandle {
  peer: Peer;
  send: (msg: ServerMessage) => void;
  close: (code: number, reason: string) => void;
}

export interface RoomOptions {
  maxHoldMs?: number;
  cooldownMs?: number;
}

/**
 * One live channel: the (channel, privacy-code) pair. Owns its peers and its
 * floor-control state machine. Transport-agnostic — peers are just callbacks.
 */
export class Room {
  readonly floor: FloorControl;
  private readonly peers = new Map<string, PeerHandle>();
  private joinSeqCounter = 0;

  constructor(
    readonly key: string,
    opts: RoomOptions = {},
  ) {
    const floorOpts: ConstructorParameters<typeof FloorControl>[0] = {
      onForceRelease: (_holder, seq, reason) => {
        this.broadcast({ t: "floor-released", v: PROTOCOL_VERSION, seq, reason });
      },
    };
    if (opts.maxHoldMs !== undefined) floorOpts.maxHoldMs = opts.maxHoldMs;
    if (opts.cooldownMs !== undefined) floorOpts.cooldownMs = opts.cooldownMs;
    this.floor = new FloorControl(floorOpts);
  }

  get size(): number {
    return this.peers.size;
  }

  get peerList(): Peer[] {
    return [...this.peers.values()].map((h) => h.peer);
  }

  hasCallsign(callsign: string): boolean {
    const wanted = callsign.toLowerCase();
    return this.peerList.some((p) => p.callsign.toLowerCase() === wanted);
  }

  addPeer(callsign: string, send: PeerHandle["send"], close: PeerHandle["close"]): PeerHandle {
    this.joinSeqCounter += 1;
    const handle: PeerHandle = {
      peer: {
        peerId: randomUUID(),
        callsign,
        status: "available",
        joinSeq: this.joinSeqCounter,
      },
      send,
      close,
    };
    this.broadcast({ t: "peer-joined", v: PROTOCOL_VERSION, peer: handle.peer });
    this.peers.set(handle.peer.peerId, handle);
    return handle;
  }

  removePeer(peerId: string): void {
    if (!this.peers.delete(peerId)) {
      return;
    }
    const released = this.floor.disconnect(peerId);
    if (released.released) {
      this.broadcast({
        t: "floor-released",
        v: PROTOCOL_VERSION,
        seq: released.seq,
        reason: "disconnected",
      });
    }
    this.broadcast({ t: "peer-left", v: PROTOCOL_VERSION, peerId });
  }

  getPeer(peerId: string): PeerHandle | undefined {
    return this.peers.get(peerId);
  }

  setStatus(peerId: string, status: PeerStatus): void {
    const handle = this.peers.get(peerId);
    if (handle === undefined || handle.peer.status === status) {
      return;
    }
    handle.peer.status = status;
    this.broadcast({ t: "status-changed", v: PROTOCOL_VERSION, peerId, status });
  }

  broadcast(msg: ServerMessage, exceptPeerId?: string): void {
    for (const [peerId, handle] of this.peers) {
      if (peerId !== exceptPeerId) {
        handle.send(msg);
      }
    }
  }

  sendTo(peerId: string, msg: ServerMessage): boolean {
    const handle = this.peers.get(peerId);
    if (handle === undefined) {
      return false;
    }
    handle.send(msg);
    return true;
  }

  dispose(): void {
    this.floor.dispose();
  }
}

export type JoinRejection = "full" | "callsign-taken";

export type JoinResult =
  | { ok: true; room: Room; handle: PeerHandle }
  | { ok: false; code: JoinRejection };

export interface RoomManagerOptions extends RoomOptions {
  maxChannelSize: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly opts: RoomManagerOptions) {}

  /** Best-effort pre-check at token-issue time (WS admission re-checks). */
  canJoin(roomKey: string, callsign: string): { ok: true } | { ok: false; code: JoinRejection } {
    const room = this.rooms.get(roomKey);
    if (room === undefined) {
      return { ok: true };
    }
    if (room.size >= this.opts.maxChannelSize) {
      return { ok: false, code: "full" };
    }
    if (room.hasCallsign(callsign)) {
      return { ok: false, code: "callsign-taken" };
    }
    return { ok: true };
  }

  /** Authoritative join at WS admission. */
  join(
    roomKey: string,
    callsign: string,
    send: PeerHandle["send"],
    close: PeerHandle["close"],
  ): JoinResult {
    const precheck = this.canJoin(roomKey, callsign);
    if (!precheck.ok) {
      return precheck;
    }
    let room = this.rooms.get(roomKey);
    if (room === undefined) {
      const roomOpts: RoomOptions = {};
      if (this.opts.maxHoldMs !== undefined) roomOpts.maxHoldMs = this.opts.maxHoldMs;
      if (this.opts.cooldownMs !== undefined) roomOpts.cooldownMs = this.opts.cooldownMs;
      room = new Room(roomKey, roomOpts);
      this.rooms.set(roomKey, room);
    }
    const handle = room.addPeer(callsign, send, close);
    return { ok: true, room, handle };
  }

  leave(roomKey: string, peerId: string): void {
    const room = this.rooms.get(roomKey);
    if (room === undefined) {
      return;
    }
    room.removePeer(peerId);
    if (room.size === 0) {
      room.dispose();
      this.rooms.delete(roomKey);
    }
  }

  /** Occupancy of every open (code 0) channel, for the join-screen display. */
  openChannelOccupancy(): Record<number, number> {
    const occupancy: Record<number, number> = {};
    for (const [key, room] of this.rooms) {
      const [channelStr, codeStr] = key.split(":");
      if (codeStr === "0" && channelStr !== undefined) {
        occupancy[Number(channelStr)] = room.size;
      }
    }
    return occupancy;
  }

  get stats(): { rooms: number; peers: number } {
    let peers = 0;
    for (const room of this.rooms.values()) {
      peers += room.size;
    }
    return { rooms: this.rooms.size, peers };
  }
}
