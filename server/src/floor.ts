import {
  MAX_HOLD_MS,
  RELEASE_COOLDOWN_MS,
  type FloorDenyReason,
  type FloorReleaseReason,
  type FloorState,
} from "@walkietalkie/shared";

export type FloorRequestResult =
  | { ok: true; seq: number; maxHoldMs: number }
  | { ok: false; reason: FloorDenyReason; holder?: string };

export type FloorReleaseResult = { released: false } | { released: true; seq: number };

export interface FloorControlOptions {
  maxHoldMs?: number;
  cooldownMs?: number;
  /** Fired when the max-hold timer force-releases the floor. */
  onForceRelease: (holder: string, seq: number, reason: FloorReleaseReason) => void;
  now?: () => number;
}

/**
 * Per-room floor-control state machine. Invariant: at most one holder at any
 * time; every transition increments `seq`. See docs/PROTOCOL.md.
 */
export class FloorControl {
  private holder: string | null = null;
  private since = 0;
  private seq = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private lastRelease = new Map<string, number>();

  private readonly maxHoldMs: number;
  private readonly cooldownMs: number;
  private readonly onForceRelease: FloorControlOptions["onForceRelease"];
  private readonly now: () => number;

  constructor(opts: FloorControlOptions) {
    this.maxHoldMs = opts.maxHoldMs ?? MAX_HOLD_MS;
    this.cooldownMs = opts.cooldownMs ?? RELEASE_COOLDOWN_MS;
    this.onForceRelease = opts.onForceRelease;
    this.now = opts.now ?? Date.now;
  }

  get state(): FloorState {
    return this.holder === null ? { holder: null } : { holder: this.holder, since: this.since };
  }

  get currentSeq(): number {
    return this.seq;
  }

  request(peerId: string): FloorRequestResult {
    if (this.holder !== null) {
      return { ok: false, reason: "busy", holder: this.holder };
    }
    const releasedAt = this.lastRelease.get(peerId);
    if (releasedAt !== undefined && this.now() - releasedAt < this.cooldownMs) {
      return { ok: false, reason: "cooldown" };
    }
    this.holder = peerId;
    this.since = this.now();
    this.seq += 1;
    this.holdTimer = setTimeout(() => {
      const released = this.releaseInternal(peerId);
      if (released.released) {
        // The peer who never voluntarily releases is the archetypal channel
        // monopolist — the cooldown (PROTOCOL.md invariant 5) must apply to
        // the timeout path too, or hold-to-timeout re-grab loops forever.
        this.lastRelease.set(peerId, this.now());
        this.onForceRelease(peerId, released.seq, "timeout");
      }
    }, this.maxHoldMs);
    // Do not keep the process alive just for a hold timer.
    this.holdTimer.unref?.();
    return { ok: true, seq: this.seq, maxHoldMs: this.maxHoldMs };
  }

  /** Voluntary release. No-op unless `peerId` is the current holder. */
  release(peerId: string): FloorReleaseResult {
    const result = this.releaseInternal(peerId);
    if (result.released) {
      this.lastRelease.set(peerId, this.now());
    }
    return result;
  }

  /** Holder (or any peer) left the room. Clears cooldown bookkeeping. */
  disconnect(peerId: string): FloorReleaseResult {
    this.lastRelease.delete(peerId);
    return this.releaseInternal(peerId);
  }

  dispose(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private releaseInternal(peerId: string): FloorReleaseResult {
    if (this.holder !== peerId) {
      return { released: false };
    }
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.holder = null;
    this.seq += 1;
    return { released: true, seq: this.seq };
  }
}
