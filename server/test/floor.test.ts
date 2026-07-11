import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloorControl } from "../src/floor.js";

describe("FloorControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(onForceRelease = vi.fn()) {
    const floor = new FloorControl({
      maxHoldMs: 1000,
      cooldownMs: 250,
      onForceRelease,
    });
    return { floor, onForceRelease };
  }

  it("grants the floor when free", () => {
    const { floor } = make();
    const result = floor.request("a");
    expect(result).toMatchObject({ ok: true, seq: 1, maxHoldMs: 1000 });
    expect(floor.state.holder).toBe("a");
  });

  it("denies with busy while held, reporting the holder", () => {
    const { floor } = make();
    floor.request("a");
    expect(floor.request("b")).toMatchObject({ ok: false, reason: "busy", holder: "a" });
  });

  it("denies the same holder as busy on double-request", () => {
    const { floor } = make();
    floor.request("a");
    expect(floor.request("a")).toMatchObject({ ok: false, reason: "busy" });
  });

  it("release frees the floor and bumps seq", () => {
    const { floor } = make();
    floor.request("a");
    const released = floor.release("a");
    expect(released).toMatchObject({ released: true, seq: 2 });
    expect(floor.state.holder).toBeNull();
  });

  it("release by a non-holder is a no-op", () => {
    const { floor } = make();
    floor.request("a");
    expect(floor.release("b")).toEqual({ released: false });
    expect(floor.state.holder).toBe("a");
  });

  it("enforces per-peer cooldown after voluntary release, but not for others", () => {
    const { floor } = make();
    floor.request("a");
    floor.release("a");
    expect(floor.request("a")).toMatchObject({ ok: false, reason: "cooldown" });
    expect(floor.request("b")).toMatchObject({ ok: true });
  });

  it("lets the releasing peer re-acquire after the cooldown elapses", () => {
    const { floor } = make();
    floor.request("a");
    floor.release("a");
    vi.advanceTimersByTime(251);
    expect(floor.request("a")).toMatchObject({ ok: true });
  });

  it("force-releases at max hold and fires the callback", () => {
    const { floor, onForceRelease } = make();
    floor.request("a");
    vi.advanceTimersByTime(1000);
    expect(onForceRelease).toHaveBeenCalledWith("a", 2, "timeout");
    expect(floor.state.holder).toBeNull();
  });

  it("applies the cooldown after a timeout force-release (anti-monopoly)", () => {
    const { floor } = make();
    floor.request("a");
    vi.advanceTimersByTime(1000); // force-release fires
    expect(floor.request("a")).toMatchObject({ ok: false, reason: "cooldown" });
    // other peers are unaffected
    expect(floor.request("b")).toMatchObject({ ok: true });
  });

  it("lets the timed-out peer back in once the cooldown elapses", () => {
    const { floor } = make();
    floor.request("a");
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(251);
    expect(floor.request("a")).toMatchObject({ ok: true });
  });

  it("does not fire the timeout callback after a voluntary release", () => {
    const { floor, onForceRelease } = make();
    floor.request("a");
    floor.release("a");
    vi.advanceTimersByTime(5000);
    expect(onForceRelease).not.toHaveBeenCalled();
  });

  it("disconnect releases the floor without cooldown bookkeeping", () => {
    const { floor } = make();
    floor.request("a");
    const released = floor.disconnect("a");
    expect(released).toMatchObject({ released: true, seq: 2 });
    // "a" reconnecting is not subject to cooldown (disconnect clears it)
    expect(floor.request("a")).toMatchObject({ ok: true });
  });

  it("keeps seq strictly monotonic across a grant/release cycle chain", () => {
    const { floor } = make();
    const seqs: number[] = [];
    for (const peer of ["a", "b", "a"]) {
      vi.advanceTimersByTime(300);
      const grant = floor.request(peer);
      if (grant.ok) seqs.push(grant.seq);
      const rel = floor.release(peer);
      if (rel.released) seqs.push(rel.seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
