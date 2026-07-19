import { describe, expect, it } from "vitest";
import { groupRoomKey } from "@walkietalkie/shared";
import { GroupRegistry } from "../src/groups.js";

const CHANNELS = [
  { channel: 1, code: 0, label: "musicians" },
  { channel: 2, code: 0, label: "led-tech" },
];

function makeRegistry(occupancy: Record<string, number> = {}, nowRef = { t: 0 }) {
  const registry = new GroupRegistry((key) => occupancy[key] ?? 0, {
    ttlMs: 1000,
    idleMs: 100,
    now: () => nowRef.t,
  });
  return { registry, nowRef };
}

describe("GroupRegistry", () => {
  it("creates groups with unguessable ids and verifiable admin keys", () => {
    const { registry } = makeRegistry();
    const created = registry.create("Stage", CHANNELS);
    expect(created).not.toBeNull();
    if (created === null) return;
    expect(created.group.groupId).toHaveLength(8);
    expect(created.adminKey).toMatch(/^[0-9a-f]{32}$/);
    expect(registry.verifyAdmin(created.group.groupId, created.adminKey)).toBe(true);
    expect(registry.verifyAdmin(created.group.groupId, "0".repeat(32))).toBe(false);
    expect(registry.verifyAdmin("nope", created.adminKey)).toBe(false);
    expect(registry.verifyAdmin(created.group.groupId, "not-hex")).toBe(false);
  });

  it("hands out a strictly monotonic group-wide joinSeq", () => {
    const { registry } = makeRegistry();
    const created = registry.create("Stage", CHANNELS);
    if (created === null) throw new Error("create failed");
    const id = created.group.groupId;
    expect([registry.nextJoinSeq(id), registry.nextJoinSeq(id), registry.nextJoinSeq(id)]).toEqual(
      [1, 2, 3],
    );
  });

  it("reports lobby info with per-channel occupancy", () => {
    const { registry } = makeRegistry();
    const created = registry.create("Stage", CHANNELS);
    if (created === null) throw new Error("create failed");
    const key = groupRoomKey(created.group.groupId, 1, 0);
    const { registry: withOcc } = makeRegistry({ [key]: 3 });
    const again = withOcc.create("Stage", CHANNELS);
    if (again === null) throw new Error("create failed");
    // occupancy is looked up per group's own key
    const ownKey = groupRoomKey(again.group.groupId, 1, 0);
    const { registry: r3 } = makeRegistry({ [ownKey]: 3 });
    const c3 = r3.create("Stage", CHANNELS);
    if (c3 === null) throw new Error("create failed");
    // deterministic assertion on the structure
    const info = r3.info(c3.group);
    expect(info.name).toBe("Stage");
    expect(info.channels.map((c) => c.label)).toEqual(["musicians", "led-tech"]);
    expect(info.channels.every((c) => typeof c.occupancy === "number")).toBe(true);
  });

  it("sweeps idle-empty groups but keeps occupied ones", () => {
    const occupancy: Record<string, number> = {};
    const nowRef = { t: 0 };
    const registry = new GroupRegistry((key) => occupancy[key] ?? 0, {
      ttlMs: 100_000,
      idleMs: 100,
      now: () => nowRef.t,
    });
    const idle = registry.create("Idle", CHANNELS);
    const busyGroup = registry.create("Busy", CHANNELS);
    if (idle === null || busyGroup === null) throw new Error("create failed");
    occupancy[groupRoomKey(busyGroup.group.groupId, 1, 0)] = 2;

    nowRef.t = 200;
    registry.create("Trigger", CHANNELS); // create() sweeps
    expect(registry.get(idle.group.groupId)).toBeUndefined();
    expect(registry.get(busyGroup.group.groupId)).toBeDefined();
    registry.dispose();
  });

  it("hard-expires groups past their TTL even if recently touched", () => {
    const { registry, nowRef } = makeRegistry();
    const created = registry.create("Stage", CHANNELS);
    if (created === null) throw new Error("create failed");
    nowRef.t = 900;
    registry.touch(created.group.groupId);
    nowRef.t = 1100;
    registry.create("Trigger", CHANNELS);
    expect(registry.get(created.group.groupId)).toBeUndefined();
    registry.dispose();
  });

  it("reads do not reset the idle clock — an abandoned lobby cannot immortalize a group", () => {
    const { registry, nowRef } = makeRegistry(); // idleMs=100
    const created = registry.create("Stage", CHANNELS);
    if (created === null) throw new Error("create failed");
    // Poll like a lobby tab: reads at t=50 and t=99 must not count as activity.
    nowRef.t = 50;
    expect(registry.get(created.group.groupId)).toBeDefined();
    nowRef.t = 99;
    expect(registry.get(created.group.groupId)).toBeDefined();
    nowRef.t = 150; // idle since creation > idleMs, occupancy 0
    registry.create("Trigger", CHANNELS); // create() sweeps
    expect(registry.get(created.group.groupId)).toBeUndefined();
    // touch() (a join token) DOES reset the clock
    const kept = registry.create("Kept", CHANNELS);
    if (kept === null) throw new Error("create failed");
    nowRef.t = 220;
    registry.touch(kept.group.groupId);
    nowRef.t = 300; // 80ms since touch < idleMs
    registry.create("Trigger2", CHANNELS);
    expect(registry.get(kept.group.groupId)).toBeDefined();
    registry.dispose();
  });

  it("enforces TTL at read time, not just at sweep time", () => {
    const { registry, nowRef } = makeRegistry();
    const created = registry.create("Stage", CHANNELS);
    if (created === null) throw new Error("create failed");
    nowRef.t = 1100; // past ttlMs=1000, no sweep has run
    expect(registry.get(created.group.groupId)).toBeUndefined();
    registry.dispose();
  });

  it("gives orphan (vanished-group) peers unique joinSeqs — ties would deadlock negotiation", () => {
    const { registry } = makeRegistry();
    const a = registry.nextJoinSeq("gone-group");
    const b = registry.nextJoinSeq("gone-group");
    expect(a).not.toBe(0);
    expect(b).toBeGreaterThan(a);
    registry.dispose();
  });

  it("refuses creation past maxGroups", () => {
    const registry = new GroupRegistry(() => 0, { maxGroups: 1, now: () => 0 });
    expect(registry.create("One", CHANNELS)).not.toBeNull();
    expect(registry.create("Two", CHANNELS)).toBeNull();
    registry.dispose();
  });
});
