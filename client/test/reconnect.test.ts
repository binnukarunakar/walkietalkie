import { describe, expect, it } from "vitest";
import {
  MAX_CALLSIGN_TAKEN_RETRIES,
  RECONNECT_MAX_MS,
  backoffDelayMs,
  isFatalCloseCode,
  isRetryableJoinError,
} from "../src/lib/reconnect";

describe("isFatalCloseCode", () => {
  it("treats auth/room rejections as fatal", () => {
    for (const code of [4400, 4401, 4409, 4423]) {
      expect(isFatalCloseCode(code)).toBe(true);
    }
  });

  it("treats network-ish codes as retryable", () => {
    for (const code of [1000, 1001, 1006, 1011, 4002, -1]) {
      expect(isFatalCloseCode(code)).toBe(false);
    }
  });
});

describe("backoffDelayMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect(backoffDelayMs(0)).toBe(1_000);
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(RECONNECT_MAX_MS);
    expect(backoffDelayMs(20)).toBe(RECONNECT_MAX_MS);
  });
});

describe("isRetryableJoinError", () => {
  it("retries transient server errors regardless of attempt", () => {
    expect(isRetryableJoinError({ status: 502, code: "unknown" }, 0)).toBe(true);
    expect(isRetryableJoinError({ status: 500, code: "unknown" }, 3)).toBe(true);
    expect(isRetryableJoinError({ status: 429, code: "unknown" }, 0)).toBe(true);
  });

  it("fails fast on definitive rejections of a fresh join", () => {
    expect(isRetryableJoinError({ status: 409, code: "callsign-taken" }, 0)).toBe(false);
    expect(isRetryableJoinError({ status: 423, code: "full" }, 0)).toBe(false);
    expect(isRetryableJoinError({ status: 400, code: "invalid-request" }, 0)).toBe(false);
  });

  it("retries our own ghost's callsign-taken during auto-reconnect, bounded", () => {
    expect(isRetryableJoinError({ status: 409, code: "callsign-taken" }, 1)).toBe(true);
    expect(
      isRetryableJoinError({ status: 409, code: "callsign-taken" }, MAX_CALLSIGN_TAKEN_RETRIES),
    ).toBe(true);
    expect(
      isRetryableJoinError(
        { status: 409, code: "callsign-taken" },
        MAX_CALLSIGN_TAKEN_RETRIES + 1,
      ),
    ).toBe(false);
  });

  it("never retries a full channel during reconnect", () => {
    expect(isRetryableJoinError({ status: 423, code: "full" }, 2)).toBe(false);
  });
});
