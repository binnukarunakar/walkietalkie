import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  groupRoomKey,
  type GroupChannel,
  type GroupInfo,
} from "@walkietalkie/shared";
import type { AnnounceDeps } from "./announce.js";
import type { RoomManager } from "./rooms.js";

export interface Group {
  groupId: string;
  name: string;
  channels: GroupChannel[];
  createdAt: number;
  lastActiveAt: number;
  /** Shared joinSeq counter: politeness stays a total order across the group. */
  nextJoinSeq: number;
}

interface StoredGroup extends Group {
  adminKey: Buffer;
}

export interface GroupRegistryOptions {
  maxGroups?: number;
  /** Hard lifetime cap. */
  ttlMs?: number;
  /** Deleted after this long with zero occupancy. */
  idleMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_GROUPS = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * In-memory group registry. Nothing persists — a group is a runtime
 * namespace with a capability key, GC'd when idle or expired, consistent
 * with the app's no-accounts, no-database design.
 */
export class GroupRegistry {
  private readonly groups = new Map<string, StoredGroup>();
  private readonly maxGroups: number;
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly occupancyOf: (roomKey: string) => number,
    opts: GroupRegistryOptions = {},
  ) {
    this.maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.now = opts.now ?? Date.now;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  create(name: string, channels: GroupChannel[]): { group: Group; adminKey: string } | null {
    this.sweep();
    if (this.groups.size >= this.maxGroups) {
      return null;
    }
    const groupId = randomBytes(6).toString("base64url"); // 8 chars, unguessable
    const adminKey = randomBytes(16).toString("hex");
    const group: StoredGroup = {
      groupId,
      name,
      channels,
      createdAt: this.now(),
      lastActiveAt: this.now(),
      nextJoinSeq: 0,
      adminKey: Buffer.from(adminKey, "hex"),
    };
    this.groups.set(groupId, group);
    return { group, adminKey };
  }

  get(groupId: string): Group | undefined {
    const group = this.groups.get(groupId);
    if (group === undefined) {
      return undefined;
    }
    // TTL is enforced at read, not just at sweep time — otherwise a stale
    // entry keeps minting tokens between sweeps.
    if (this.now() - group.createdAt > this.ttlMs) {
      this.groups.delete(groupId);
      return undefined;
    }
    group.lastActiveAt = this.now();
    return group;
  }

  verifyAdmin(groupId: string, adminKey: string): boolean {
    const group = this.groups.get(groupId);
    if (group === undefined || !/^[0-9a-f]{32}$/.test(adminKey)) {
      return false;
    }
    return timingSafeEqual(group.adminKey, Buffer.from(adminKey, "hex"));
  }

  /** Distinct from any real seq: ties would make BOTH peers impolite and
   * deadlock WebRTC negotiation, so even orphans get unique values. */
  private orphanSeq = 1_000_000;

  /** Draw the next group-wide joinSeq (used by every room in the group). */
  nextJoinSeq(groupId: string): number {
    const group = this.groups.get(groupId);
    if (group === undefined) {
      this.orphanSeq += 1;
      return this.orphanSeq;
    }
    group.nextJoinSeq += 1;
    return group.nextJoinSeq;
  }

  roomKeys(group: Group): string[] {
    return group.channels.map((c) => groupRoomKey(group.groupId, c.channel, c.code));
  }

  info(group: Group): GroupInfo {
    return {
      groupId: group.groupId,
      name: group.name,
      channels: group.channels.map((c) => ({
        ...c,
        occupancy: this.occupancyOf(groupRoomKey(group.groupId, c.channel, c.code)),
      })),
    };
  }

  totalOccupancy(group: Group): number {
    return this.roomKeys(group).reduce((sum, key) => sum + this.occupancyOf(key), 0);
  }

  get size(): number {
    return this.groups.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, group] of this.groups) {
      const expired = now - group.createdAt > this.ttlMs;
      const idle =
        now - group.lastActiveAt > this.idleMs && this.totalOccupancy(group) === 0;
      if (expired || idle) {
        this.groups.delete(id);
      }
    }
  }
}

/** The group-aware slice of WsDeps — shared by index.ts and the tests. */
export function groupWsDeps(
  registry: GroupRegistry,
  roomManager: RoomManager,
): {
  announceDeps: (groupId: string | undefined) => AnnounceDeps;
  memberJoinSeq: (groupId: string | undefined) => number | undefined;
} {
  return {
    announceDeps: (groupId) => ({
      roomManager,
      nextJoinSeq: () => registry.nextJoinSeq(groupId ?? ""),
      labelOf: (roomKey) => {
        if (groupId !== undefined) {
          const group = registry.get(groupId);
          const channel = group?.channels.find(
            (c) => groupRoomKey(groupId, c.channel, c.code) === roomKey,
          );
          if (channel !== undefined) {
            return channel.label;
          }
        }
        return roomKey;
      },
    }),
    memberJoinSeq: (groupId) =>
      groupId === undefined ? undefined : registry.nextJoinSeq(groupId),
  };
}
