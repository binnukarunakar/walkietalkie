import { describe, expect, it } from "vitest";
import {
  CALLSIGN_PATTERN,
  FRS_CHANNELS,
  clientMessageSchema,
  frequencyLabel,
  joinRequestSchema,
  roomKey,
} from "../src/index.js";

describe("FRS table", () => {
  it("has all 22 channels with plausible UHF frequencies", () => {
    expect(FRS_CHANNELS.size).toBe(22);
    for (const [ch, mhz] of FRS_CHANNELS) {
      expect(ch).toBeGreaterThanOrEqual(1);
      expect(ch).toBeLessThanOrEqual(22);
      expect(mhz).toBeGreaterThan(462);
      expect(mhz).toBeLessThan(468);
    }
  });

  it("labels frequencies to four decimals", () => {
    expect(frequencyLabel(3)).toBe("462.6125 MHz");
    expect(frequencyLabel(15)).toBe("462.5500 MHz");
  });

  it("builds room keys", () => {
    expect(roomKey(3, 0)).toBe("3:0");
  });
});

describe("joinRequestSchema", () => {
  it("accepts a valid join and trims the callsign", () => {
    const parsed = joinRequestSchema.parse({ channel: 22, code: 38, callsign: "  Alpha 1 " });
    expect(parsed.callsign).toBe("Alpha 1");
  });

  it.each([
    { channel: 0, code: 0, callsign: "Alpha" },
    { channel: 23, code: 0, callsign: "Alpha" },
    { channel: 1, code: -1, callsign: "Alpha" },
    { channel: 1, code: 39, callsign: "Alpha" },
    { channel: 1.5, code: 0, callsign: "Alpha" },
    { channel: 1, code: 0, callsign: "A" },
    { channel: 1, code: 0, callsign: "-starts-with-dash" },
    { channel: 1, code: 0, callsign: "has<angle>" },
  ])("rejects %j", (payload) => {
    expect(joinRequestSchema.safeParse(payload).success).toBe(false);
  });

  it("callsign pattern requires an alphanumeric start", () => {
    expect(CALLSIGN_PATTERN.test("Alpha-1")).toBe(true);
    expect(CALLSIGN_PATTERN.test(" leading")).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  it("accepts every message type", () => {
    for (const msg of [
      { t: "request-floor", v: 1 },
      { t: "release-floor", v: 1 },
      { t: "signal", v: 1, to: "abc", data: { sdp: "x" } },
      { t: "set-status", v: 1, status: "busy" },
      { t: "ping", v: 1 },
    ]) {
      expect(clientMessageSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects unknown types, wrong versions, and malformed payloads", () => {
    for (const msg of [
      { t: "nuke-room", v: 1 },
      { t: "request-floor", v: 2 },
      { t: "signal", v: 1, to: "", data: {} },
      { t: "signal", v: 1, data: {} },
      { t: "set-status", v: 1, status: "invisible" },
      "just a string",
      42,
    ]) {
      expect(clientMessageSchema.safeParse(msg).success).toBe(false);
    }
  });
});
