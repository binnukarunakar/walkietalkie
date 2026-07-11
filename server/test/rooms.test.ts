import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@walkietalkie/shared";
import { RoomManager } from "../src/rooms.js";

function makeManager(maxChannelSize = 3) {
  return new RoomManager({ maxChannelSize, maxHoldMs: 1000, cooldownMs: 0 });
}

function fakePeer() {
  const inbox: ServerMessage[] = [];
  return {
    inbox,
    send: (msg: ServerMessage) => inbox.push(msg),
    close: vi.fn(),
  };
}

describe("RoomManager", () => {
  it("admits peers and existing members learn of newcomers", () => {
    const mgr = makeManager();
    const a = fakePeer();
    const b = fakePeer();
    const ja = mgr.join("3:0", "Alpha", a.send, a.close);
    const jb = mgr.join("3:0", "Bravo", b.send, b.close);
    expect(ja.ok && jb.ok).toBe(true);
    const joined = a.inbox.find((m) => m.t === "peer-joined");
    expect(joined && joined.t === "peer-joined" && joined.peer.callsign).toBe("Bravo");
    // the newcomer does not receive its own peer-joined
    expect(b.inbox.filter((m) => m.t === "peer-joined")).toHaveLength(0);
  });

  it("rejects when the channel is full", () => {
    const mgr = makeManager(2);
    const peers = [fakePeer(), fakePeer(), fakePeer()];
    mgr.join("1:0", "One", peers[0]!.send, peers[0]!.close);
    mgr.join("1:0", "Two", peers[1]!.send, peers[1]!.close);
    const third = mgr.join("1:0", "Three", peers[2]!.send, peers[2]!.close);
    expect(third).toEqual({ ok: false, code: "full" });
  });

  it("rejects duplicate callsigns case-insensitively", () => {
    const mgr = makeManager();
    const a = fakePeer();
    const b = fakePeer();
    mgr.join("1:0", "Maverick", a.send, a.close);
    const dup = mgr.join("1:0", "mAvErIcK", b.send, b.close);
    expect(dup).toEqual({ ok: false, code: "callsign-taken" });
  });

  it("isolates rooms by (channel, code) — same channel, different code", () => {
    const mgr = makeManager();
    const a = fakePeer();
    const b = fakePeer();
    mgr.join("3:1", "Alpha", a.send, a.close);
    mgr.join("3:2", "Bravo", b.send, b.close);
    expect(a.inbox.filter((m) => m.t === "peer-joined")).toHaveLength(0);
    expect(mgr.stats).toEqual({ rooms: 2, peers: 2 });
  });

  it("releases the floor and notifies when the holder leaves", () => {
    const mgr = makeManager();
    const a = fakePeer();
    const b = fakePeer();
    const ja = mgr.join("5:0", "Alpha", a.send, a.close);
    mgr.join("5:0", "Bravo", b.send, b.close);
    if (!ja.ok) throw new Error("join failed");
    ja.room.floor.request(ja.handle.peer.peerId);
    mgr.leave("5:0", ja.handle.peer.peerId);
    const released = b.inbox.find((m) => m.t === "floor-released");
    expect(released && released.t === "floor-released" && released.reason).toBe("disconnected");
    expect(b.inbox.some((m) => m.t === "peer-left")).toBe(true);
  });

  it("garbage-collects empty rooms", () => {
    const mgr = makeManager();
    const a = fakePeer();
    const ja = mgr.join("7:0", "Alpha", a.send, a.close);
    if (!ja.ok) throw new Error("join failed");
    mgr.leave("7:0", ja.handle.peer.peerId);
    expect(mgr.stats).toEqual({ rooms: 0, peers: 0 });
    // and the callsign is free again
    expect(mgr.canJoin("7:0", "Alpha")).toEqual({ ok: true });
  });

  it("reports occupancy for open (code 0) channels only", () => {
    const mgr = makeManager();
    const peers = [fakePeer(), fakePeer(), fakePeer()];
    mgr.join("3:0", "Alpha", peers[0]!.send, peers[0]!.close);
    mgr.join("3:0", "Bravo", peers[1]!.send, peers[1]!.close);
    mgr.join("9:5", "Charlie", peers[2]!.send, peers[2]!.close);
    expect(mgr.openChannelOccupancy()).toEqual({ 3: 2 });
  });

  it("status changes broadcast to the room", () => {
    const mgr = makeManager();
    const a = fakePeer();
    const b = fakePeer();
    const ja = mgr.join("2:0", "Alpha", a.send, a.close);
    mgr.join("2:0", "Bravo", b.send, b.close);
    if (!ja.ok) throw new Error("join failed");
    ja.room.setStatus(ja.handle.peer.peerId, "busy");
    const change = b.inbox.find((m) => m.t === "status-changed");
    expect(change && change.t === "status-changed" && change.status).toBe("busy");
  });
});
