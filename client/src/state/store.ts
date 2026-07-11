import { create } from "zustand";
import type { FloorDenyReason, Peer, PeerStatus } from "@walkietalkie/shared";
import { appendReplay, type ReplayEntry } from "../lib/replay";

export type Phase = "join" | "connecting" | "onair";

export interface JoinParams {
  channel: number;
  code: number;
  callsign: string;
}

export interface PeerAudioPrefs {
  volume: number;
  muted: boolean;
}

interface RadioState {
  phase: Phase;
  join: JoinParams;
  selfId: string | null;
  peers: Record<string, Peer>;
  floorHolder: string | null;
  floorSeq: number;
  /** True while we hold the floor and the mic is live. */
  transmitting: boolean;
  /** True between request-floor and grant/deny. */
  requesting: boolean;
  lastDeny: { reason: FloorDenyReason; at: number } | null;
  error: string | null;
  selfStatus: PeerStatus;
  deafened: boolean;
  peerAudio: Record<string, PeerAudioPrefs>;
  replays: ReplayEntry[];
  /** Set when VOX turned itself off after repeated max-hold timeouts. */
  voxAutoDisabled: boolean;

  setJoin: (params: Partial<JoinParams>) => void;
  setPhase: (phase: Phase) => void;
  setError: (error: string | null) => void;
  welcome: (selfId: string, peers: Peer[], holder: string | null, seq: number) => void;
  peerJoined: (peer: Peer) => void;
  peerLeft: (peerId: string) => void;
  peerStatus: (peerId: string, status: PeerStatus) => void;
  /**
   * Apply a floor transition; returns false when the seq is stale so callers
   * skip side effects (audio gating, mic enable) too — not just the UI.
   * `wantTransmit`: the PTT is still physically held / VOX still keyed, so a
   * grant to self may actually open the mic.
   */
  floorGranted: (holder: string, seq: number, wantTransmit: boolean) => boolean;
  floorReleased: (seq: number) => boolean;
  floorDenied: (reason: FloorDenyReason) => void;
  clearDeny: () => void;
  setRequesting: (requesting: boolean) => void;
  connectionLost: () => void;
  setSelfStatus: (status: PeerStatus) => void;
  setDeafened: (deafened: boolean) => void;
  setPeerAudio: (peerId: string, patch: Partial<PeerAudioPrefs>) => void;
  addReplay: (entry: ReplayEntry) => void;
  setVoxAutoDisabled: (disabled: boolean) => void;
  reset: () => void;
}

const initial = {
  phase: "join" as Phase,
  selfId: null,
  peers: {},
  floorHolder: null,
  floorSeq: 0,
  transmitting: false,
  requesting: false,
  lastDeny: null,
  error: null,
  selfStatus: "available" as PeerStatus,
  deafened: false,
  peerAudio: {},
  replays: [] as ReplayEntry[],
  voxAutoDisabled: false,
};

export const useRadioStore = create<RadioState>((set, get) => ({
  ...initial,
  join: { channel: 3, code: 0, callsign: "" },

  setJoin: (params) => set({ join: { ...get().join, ...params } }),
  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error }),

  welcome: (selfId, peers, holder, seq) =>
    set({
      selfId,
      peers: Object.fromEntries(peers.map((p) => [p.peerId, p])),
      floorHolder: holder,
      floorSeq: seq,
      phase: "onair",
      error: null,
      // A fresh session has a fresh peerId and by definition holds nothing;
      // without this, a mid-transmission reconnect leaves PTT dead forever.
      transmitting: false,
      requesting: false,
      lastDeny: null,
    }),

  peerJoined: (peer) => set({ peers: { ...get().peers, [peer.peerId]: peer } }),

  peerLeft: (peerId) => {
    const peers = { ...get().peers };
    delete peers[peerId];
    set({ peers });
  },

  peerStatus: (peerId, status) => {
    const existing = get().peers[peerId];
    if (existing === undefined) return;
    set({ peers: { ...get().peers, [peerId]: { ...existing, status } } });
  },

  floorGranted: (holder, seq, wantTransmit) => {
    if (seq <= get().floorSeq) return false; // stale transition
    set({
      floorHolder: holder,
      floorSeq: seq,
      requesting: false,
      transmitting: holder === get().selfId && wantTransmit,
    });
    return true;
  },

  floorReleased: (seq) => {
    if (seq <= get().floorSeq) return false;
    set({ floorHolder: null, floorSeq: seq, transmitting: false });
    return true;
  },

  floorDenied: (reason) => set({ requesting: false, lastDeny: { reason, at: Date.now() } }),

  clearDeny: () => set({ lastDeny: null }),

  setRequesting: (requesting) => set({ requesting }),

  connectionLost: () =>
    set({ phase: "connecting", transmitting: false, requesting: false }),

  setSelfStatus: (selfStatus) => set({ selfStatus }),

  setDeafened: (deafened) => set({ deafened }),

  setPeerAudio: (peerId, patch) => {
    const current = get().peerAudio[peerId] ?? { volume: 1, muted: false };
    set({ peerAudio: { ...get().peerAudio, [peerId]: { ...current, ...patch } } });
  },

  addReplay: (entry) => set({ replays: appendReplay(get().replays, entry) }),

  setVoxAutoDisabled: (voxAutoDisabled) => set({ voxAutoDisabled }),

  reset: () => set({ ...initial }),
}));
