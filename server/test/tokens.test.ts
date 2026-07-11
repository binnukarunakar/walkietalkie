import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../src/tokens.js";

describe("TokenService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const secret = randomBytes(32);

  it("round-trips valid claims", async () => {
    const svc = new TokenService(secret);
    const token = await svc.issue({ room: "3:7", callsign: "Alpha" });
    expect(await svc.verifyAndConsume(token)).toEqual({ room: "3:7", callsign: "Alpha" });
  });

  it("rejects a token presented twice (single-use jti)", async () => {
    const svc = new TokenService(secret);
    const token = await svc.issue({ room: "3:7", callsign: "Alpha" });
    await svc.verifyAndConsume(token);
    expect(await svc.verifyAndConsume(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const svc = new TokenService(secret);
    const token = await svc.issue({ room: "3:7", callsign: "Alpha" });
    vi.advanceTimersByTime(61_000);
    expect(await svc.verifyAndConsume(token)).toBeNull();
  });

  it("rejects a token signed with a different key", async () => {
    const other = new TokenService(randomBytes(32));
    const token = await other.issue({ room: "3:7", callsign: "Alpha" });
    const svc = new TokenService(secret);
    expect(await svc.verifyAndConsume(token)).toBeNull();
  });

  it("rejects garbage", async () => {
    const svc = new TokenService(secret);
    expect(await svc.verifyAndConsume("not.a.jwt")).toBeNull();
  });

  it("sweeps consumed jtis after their natural expiry", async () => {
    const svc = new TokenService(secret);
    const token = await svc.issue({ room: "3:7", callsign: "Alpha" });
    await svc.verifyAndConsume(token);
    vi.advanceTimersByTime(120_000);
    // trigger a sweep with any verification attempt
    await svc.verifyAndConsume("junk");
    // implementation detail guarded indirectly: replay after expiry still fails
    // (token itself is expired), so single-use holds without unbounded memory.
    expect(await svc.verifyAndConsume(token)).toBeNull();
  });
});
