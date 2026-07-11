import { describe, expect, it } from "vitest";
import {
  VOX_HANGOVER_MS,
  VOX_MAX_TIMEOUTS,
  VoxGate,
  rmsDb,
} from "../src/lib/vox";

const THRESHOLD = -40;

function gate(): VoxGate {
  return new VoxGate({ thresholdDb: THRESHOLD });
}

describe("VoxGate", () => {
  it("keys when the level crosses the threshold", () => {
    const g = gate();
    expect(g.sample(-60, 0)).toBeNull();
    expect(g.sample(-30, 100)).toBe("key");
    expect(g.isKeyed).toBe(true);
  });

  it("does not re-key while already keyed", () => {
    const g = gate();
    expect(g.sample(-30, 0)).toBe("key");
    expect(g.sample(-25, 50)).toBeNull();
  });

  it("stays keyed through sub-hangover pauses", () => {
    const g = gate();
    g.sample(-30, 0);
    expect(g.sample(-60, 400)).toBeNull(); // 400ms below threshold < hangover
    expect(g.sample(-30, 500)).toBeNull(); // voice back, still keyed
    expect(g.isKeyed).toBe(true);
  });

  it("unkeys once the hangover elapses after the last above-threshold sample", () => {
    const g = gate();
    g.sample(-30, 0);
    expect(g.sample(-60, VOX_HANGOVER_MS - 1)).toBeNull();
    expect(g.sample(-60, VOX_HANGOVER_MS)).toBe("unkey");
    expect(g.isKeyed).toBe(false);
  });

  it("hangover measures from the last time the level was above threshold", () => {
    const g = gate();
    g.sample(-30, 0);
    g.sample(-30, 600); // still talking
    expect(g.sample(-60, 600 + VOX_HANGOVER_MS - 1)).toBeNull();
    expect(g.sample(-60, 600 + VOX_HANGOVER_MS)).toBe("unkey");
  });

  it("self-disables after consecutive forced timeouts", () => {
    const g = gate();
    let disabled: string | null = null;
    for (let i = 0; i < VOX_MAX_TIMEOUTS; i += 1) {
      g.sample(-30, i * 1000);
      disabled = g.noteForcedTimeout();
    }
    expect(disabled).toBe("disabled");
    expect(g.isDisabled).toBe(true);
    // A disabled gate never keys again.
    expect(g.sample(-10, 99_999)).toBeNull();
  });

  it("a clean unkey resets the forced-timeout counter", () => {
    const g = gate();
    for (let i = 0; i < VOX_MAX_TIMEOUTS - 1; i += 1) {
      g.sample(-30, i * 10_000);
      expect(g.noteForcedTimeout()).toBeNull();
    }
    // Clean cycle: key, then unkey via hangover.
    g.sample(-30, 50_000);
    expect(g.sample(-60, 50_000 + VOX_HANGOVER_MS)).toBe("unkey");
    // Counter reset: the next forced timeout is #1 again, not #3.
    g.sample(-30, 60_000);
    expect(g.noteForcedTimeout()).toBeNull();
    expect(g.isDisabled).toBe(false);
  });

  it("a denied floor request unkeys without counting as a timeout", () => {
    const g = gate();
    g.sample(-30, 0);
    g.noteDenied();
    expect(g.isKeyed).toBe(false);
    // Can key again immediately once the level re-crosses.
    expect(g.sample(-60, 100)).toBeNull();
    expect(g.sample(-30, 200)).toBe("key");
  });
});

describe("rmsDb", () => {
  it("returns -Infinity for silence and empty blocks", () => {
    expect(rmsDb(new Float32Array(0))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDb(new Float32Array(256))).toBe(Number.NEGATIVE_INFINITY);
  });

  it("full-scale square wave is 0 dBFS", () => {
    const samples = new Float32Array(256).fill(1);
    expect(rmsDb(samples)).toBeCloseTo(0, 5);
  });

  it("a full-scale sine is about -3 dBFS", () => {
    const samples = new Float32Array(4096);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * i * 16) / samples.length);
    }
    expect(rmsDb(samples)).toBeCloseTo(-3.01, 1);
  });
});
