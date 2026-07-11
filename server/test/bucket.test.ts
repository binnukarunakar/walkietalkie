import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/ws.js";

describe("TokenBucket", () => {
  function make(capacity = 10, refillPerSec = 5) {
    let nowMs = 0;
    const bucket = new TokenBucket(capacity, refillPerSec, () => nowMs);
    return { bucket, advance: (ms: number) => (nowMs += ms) };
  }

  it("allows a burst up to capacity, then refuses", () => {
    const { bucket } = make(10, 5);
    for (let i = 0; i < 10; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it("refills at the configured rate", () => {
    const { bucket, advance } = make(10, 5);
    for (let i = 0; i < 10; i++) bucket.take();
    expect(bucket.take()).toBe(false);
    advance(1000); // +5 tokens
    for (let i = 0; i < 5; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it("never refills past capacity", () => {
    const { bucket, advance } = make(10, 5);
    bucket.take();
    advance(60_000);
    let granted = 0;
    while (bucket.take()) granted += 1;
    expect(granted).toBe(10);
  });

  it("sustains exactly the refill rate under continuous pressure", () => {
    const { bucket, advance } = make(10, 5);
    while (bucket.take()) {
      // drain the initial burst
    }
    let granted = 0;
    for (let tick = 0; tick < 10; tick++) {
      advance(200); // one token per 200ms at 5/sec
      if (bucket.take()) granted += 1;
      expect(bucket.take()).toBe(false);
    }
    expect(granted).toBe(10);
  });
});
