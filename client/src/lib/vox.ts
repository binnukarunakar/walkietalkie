export const VOX_HANGOVER_MS = 800;
export const VOX_MAX_TIMEOUTS = 3;
export const VOX_THRESHOLD_DEFAULT_DB = -40;
export const VOX_THRESHOLD_MIN_DB = -70;
export const VOX_THRESHOLD_MAX_DB = -20;

export type VoxDecision = "key" | "unkey" | null;

export interface VoxGateOptions {
  thresholdDb: number;
  hangoverMs?: number;
  maxTimeouts?: number;
}

/**
 * Pure VOX decision core: feed it level samples, it says when to key and
 * unkey. Anti-thrash guards (BUILD_PLAN Gate 3):
 * - hangover: stays keyed until the level has been below threshold for
 *   `hangoverMs` (default 800 ms), so pauses between words don't unkey;
 * - self-disable: if the server force-releases a VOX transmission (max-hold
 *   timeout) `maxTimeouts` times in a row — a stuck-open mic — the gate
 *   disables itself. A clean unkey resets the counter.
 */
export class VoxGate {
  private keyed = false;
  private lastAboveMs = Number.NEGATIVE_INFINITY;
  private consecutiveTimeouts = 0;
  private disabled = false;

  private readonly thresholdDb: number;
  private readonly hangoverMs: number;
  private readonly maxTimeouts: number;

  constructor(opts: VoxGateOptions) {
    this.thresholdDb = opts.thresholdDb;
    this.hangoverMs = opts.hangoverMs ?? VOX_HANGOVER_MS;
    this.maxTimeouts = opts.maxTimeouts ?? VOX_MAX_TIMEOUTS;
  }

  get isKeyed(): boolean {
    return this.keyed;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  sample(levelDb: number, nowMs: number): VoxDecision {
    if (this.disabled) {
      return null;
    }
    if (levelDb >= this.thresholdDb) {
      this.lastAboveMs = nowMs;
      if (!this.keyed) {
        this.keyed = true;
        return "key";
      }
      return null;
    }
    if (this.keyed && nowMs - this.lastAboveMs >= this.hangoverMs) {
      this.keyed = false;
      this.consecutiveTimeouts = 0; // a clean unkey proves the mic is not stuck open
      return "unkey";
    }
    return null;
  }

  /**
   * The server force-released our VOX transmission (max-hold timeout).
   * Returns "disabled" when this trips the self-disable guard.
   */
  noteForcedTimeout(): "disabled" | null {
    this.keyed = false;
    this.consecutiveTimeouts += 1;
    if (this.consecutiveTimeouts >= this.maxTimeouts) {
      this.disabled = true;
      return "disabled";
    }
    return null;
  }

  /** Our floor request was denied (channel busy) — we never actually keyed. */
  noteDenied(): void {
    this.keyed = false;
  }
}

/** RMS level of a time-domain sample block, in dBFS (-Infinity for silence). */
export function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}
