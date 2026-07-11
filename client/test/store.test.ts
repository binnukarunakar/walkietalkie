import { beforeEach, describe, expect, it } from "vitest";
import type { Peer } from "@walkietalkie/shared";
import { useRadioStore } from "../src/state/store";

function peer(id: string, joinSeq: number): Peer {
  return { peerId: id, callsign: id, status: "available", joinSeq };
}

beforeEach(() => {
  useRadioStore.getState().reset();
});

describe("floor transitions", () => {
  it("applies grants and releases in seq order", () => {
    const s = useRadioStore.getState();
    s.welcome("me", [peer("other", 1)], null, 5);
    expect(useRadioStore.getState().floorGranted("other", 6, false)).toBe(true);
    expect(useRadioStore.getState().floorHolder).toBe("other");
    expect(useRadioStore.getState().floorReleased(7)).toBe(true);
    expect(useRadioStore.getState().floorHolder).toBeNull();
  });

  it("rejects stale transitions so callers can skip side effects", () => {
    const s = useRadioStore.getState();
    s.welcome("me", [], null, 10);
    expect(useRadioStore.getState().floorGranted("me", 10, true)).toBe(false);
    expect(useRadioStore.getState().floorGranted("me", 9, true)).toBe(false);
    expect(useRadioStore.getState().transmitting).toBe(false);
    expect(useRadioStore.getState().floorReleased(10)).toBe(false);
  });

  it("a grant to self only transmits when the button is still held", () => {
    const s = useRadioStore.getState();
    s.welcome("me", [], null, 0);
    expect(useRadioStore.getState().floorGranted("me", 1, false)).toBe(true);
    expect(useRadioStore.getState().transmitting).toBe(false);
    expect(useRadioStore.getState().floorReleased(2)).toBe(true);
    expect(useRadioStore.getState().floorGranted("me", 3, true)).toBe(true);
    expect(useRadioStore.getState().transmitting).toBe(true);
  });

  it("deny clears requesting and is clearable", () => {
    const s = useRadioStore.getState();
    s.welcome("me", [], null, 0);
    s.setRequesting(true);
    useRadioStore.getState().floorDenied("busy");
    expect(useRadioStore.getState().requesting).toBe(false);
    expect(useRadioStore.getState().lastDeny?.reason).toBe("busy");
    useRadioStore.getState().clearDeny();
    expect(useRadioStore.getState().lastDeny).toBeNull();
  });
});

describe("reconnect state hygiene", () => {
  it("welcome resets transmitting/requesting/deny from a previous session", () => {
    const s = useRadioStore.getState();
    s.welcome("old-id", [], null, 3);
    useRadioStore.getState().floorGranted("old-id", 4, true);
    expect(useRadioStore.getState().transmitting).toBe(true);
    useRadioStore.getState().setRequesting(true);
    useRadioStore.getState().floorDenied("busy");

    // Mid-transmission drop, then rejoin: fresh peerId, fresh room seq.
    useRadioStore.getState().welcome("new-id", [], null, 0);
    const after = useRadioStore.getState();
    expect(after.transmitting).toBe(false);
    expect(after.requesting).toBe(false);
    expect(after.lastDeny).toBeNull();
    expect(after.phase).toBe("onair");
    // The reset floorSeq must accept the new room's transitions from 1.
    expect(useRadioStore.getState().floorGranted("new-id", 1, true)).toBe(true);
  });

  it("connectionLost flips to connecting and stops transmit state", () => {
    const s = useRadioStore.getState();
    s.welcome("me", [], null, 0);
    useRadioStore.getState().floorGranted("me", 1, true);
    useRadioStore.getState().connectionLost();
    const after = useRadioStore.getState();
    expect(after.phase).toBe("connecting");
    expect(after.transmitting).toBe(false);
    expect(after.requesting).toBe(false);
  });
});

describe("roster", () => {
  it("tracks joins, leaves, and status changes", () => {
    const s = useRadioStore.getState();
    s.welcome("me", [peer("a", 1)], null, 0);
    useRadioStore.getState().peerJoined(peer("b", 2));
    expect(Object.keys(useRadioStore.getState().peers)).toEqual(["a", "b"]);
    useRadioStore.getState().peerStatus("b", "monitoring");
    expect(useRadioStore.getState().peers["b"]?.status).toBe("monitoring");
    useRadioStore.getState().peerStatus("ghost", "busy"); // unknown: ignored
    useRadioStore.getState().peerLeft("a");
    expect(Object.keys(useRadioStore.getState().peers)).toEqual(["b"]);
  });
});
