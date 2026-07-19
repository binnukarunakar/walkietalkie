import { PROTOCOL_VERSION, type ServerMessage, type SettableStatus } from "@walkietalkie/shared";
import { useSettings, type SettingsState } from "../state/settings";
import { useRadioStore, type JoinParams } from "../state/store";
import { AudioGraph, applyMicSettings, openMicrophone, type MicSettings } from "./audio";
import { closeCodeMessage, joinErrorMessage } from "./errors";
import { Mesh } from "./mesh";
import { backoffDelayMs, isFatalCloseCode, isRetryableJoinError } from "./reconnect";
import { TransmissionRecorder, type ReplayEntry } from "./replay";
import { acquireToken, contextOf, type SessionParams } from "./session";
import { JoinError, Signaling, fetchIceServers } from "./signaling";
import { TransmitController } from "./transmit";

/** A suspended AudioContext must not block reconnection (see join()). */
const RESUME_TIMEOUT_MS = 1_000;

/**
 * Orchestrates signaling, the WebRTC mesh, the audio graph, and the transmit
 * controller, projecting everything into the zustand store. One instance per
 * joined channel.
 */
export class RadioClient {
  private signaling: Signaling | null = null;
  private mesh: Mesh | null = null;
  private mic: MediaStream | null = null;
  private readonly audio = new AudioGraph();
  private readonly tx = new TransmitController({
    sendRequestFloor: () =>
      this.signaling?.send({
        t: this.isAnnounce ? "request-group-floor" : "request-floor",
        v: PROTOCOL_VERSION,
      }),
    sendReleaseFloor: () =>
      this.signaling?.send({
        t: this.isAnnounce ? "release-group-floor" : "release-floor",
        v: PROTOCOL_VERSION,
      }),
    audio: this.audio,
  });
  private readonly recorder = new TransmissionRecorder();
  private readonly remoteStreams = new Map<string, MediaStream>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private session: SessionParams | null = null;

  constructor() {
    // The UI writes preferences to the persisted settings store; the live
    // audio/transmit engine follows them here.
    useSettings.subscribe((s, prev) => {
      if (s.radioVoice !== prev.radioVoice) {
        this.audio.setRadioFilter(s.radioVoice);
      }
      if (s.voxEnabled !== prev.voxEnabled) {
        this.tx.setVoxEnabled(s.voxEnabled);
      } else if (s.voxEnabled && s.voxThresholdDb !== prev.voxThresholdDb) {
        this.tx.setVoxEnabled(false); // re-arm the gate with the new threshold
        this.tx.setVoxEnabled(true);
      }
      if (
        this.mic !== null &&
        (s.echoCancellation !== prev.echoCancellation ||
          s.noiseSuppression !== prev.noiseSuppression ||
          s.autoGainControl !== prev.autoGainControl)
      ) {
        void applyMicSettings(this.mic, micSettingsOf(s));
      }
    });
  }

  async join(params: JoinParams & { groupName?: string; channelLabel?: string }): Promise<void> {
    return this.start({ kind: "member", ...params });
  }

  async announce(params: {
    groupId: string;
    adminKey: string;
    callsign: string;
    groupName: string;
  }): Promise<void> {
    return this.start({ kind: "announce", ...params });
  }

  private get isAnnounce(): boolean {
    return this.session?.kind === "announce";
  }

  private async start(session: SessionParams): Promise<void> {
    const store = useRadioStore.getState();
    this.session = session;
    store.setGroupContext(contextOf(session));
    this.disposed = false; // singleton: joining again after leave() re-arms it
    store.setPhase("connecting");
    store.setError(null);

    try {
      // On the first join this runs inside the click gesture and resolves
      // instantly. On a reconnect (no gesture) Chrome may park resume()
      // until the next interaction — never let that wedge the session.
      await Promise.race([
        this.audio.resume(),
        new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
      ]);
      const settings = useSettings.getState();
      this.audio.setRadioFilter(settings.radioVoice);
      // PA sessions are transmit-only by design: force-deafen the graph.
      if (session.kind === "announce") {
        store.setDeafened(true);
      }
      this.audio.setDeafened(session.kind === "announce" ? true : store.deafened);
      if (this.mic === null) {
        this.mic = await openMicrophone(micSettingsOf(settings));
        this.tx.attachMic(this.mic);
        this.audio.attachMicProbe(this.mic);
      }
      if (this.abortIfDisposed()) return;

      const token = await acquireToken(session);
      if (this.abortIfDisposed()) return;
      const iceServers = await fetchIceServers();
      if (this.abortIfDisposed()) return;

      const signaling = new Signaling({
        onMessage: (msg) => {
          if (this.signaling === signaling && !this.disposed) {
            this.handleMessage(msg, iceServers);
          }
        },
        onDrop: (code) => {
          if (this.signaling === signaling) {
            this.handleDrop(code);
          }
        },
      });
      this.signaling = signaling;
      await signaling.connect(token);
      if (this.disposed) {
        signaling.close();
      }
    } catch (err) {
      this.handleJoinFailure(err);
      throw err;
    }
  }

  pressTalk(): void {
    this.tx.press();
  }

  releaseTalk(): void {
    this.tx.release();
  }

  leave(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.signaling?.close();
    this.signaling = null;
    this.teardownMedia();
    useRadioStore.getState().reset();
  }

  setStatus(status: SettableStatus): void {
    useRadioStore.getState().setSelfStatus(status);
    this.signaling?.send({ t: "set-status", v: PROTOCOL_VERSION, status });
  }

  setDeafened(deafened: boolean): void {
    useRadioStore.getState().setDeafened(deafened);
    this.audio.setDeafened(deafened);
  }

  setPeerVolume(peerId: string, volume: number): void {
    useRadioStore.getState().setPeerAudio(peerId, { volume });
    this.audio.setPeerVolume(peerId, volume);
  }

  setPeerMuted(peerId: string, muted: boolean): void {
    useRadioStore.getState().setPeerAudio(peerId, { muted });
    this.audio.setPeerMuted(peerId, muted);
  }

  playReplay(entry: ReplayEntry): void {
    const url = URL.createObjectURL(entry.blob);
    const element = new Audio(url);
    element.onended = () => URL.revokeObjectURL(url);
    void element.play().catch(() => URL.revokeObjectURL(url));
  }

  /** 0..1 audio level for the signal meter. */
  meterLevel(source: "mic" | "receive"): number {
    return this.audio.level(source);
  }

  /** Test/diagnostic hook: total inbound audio bytes across the mesh. */
  async inboundAudioBytes(): Promise<number> {
    return this.mesh?.inboundAudioBytes() ?? 0;
  }

  /** Test/diagnostic hook: is any local mic track live right now? */
  micEnabled(): boolean {
    return this.tx.micEnabled();
  }

  /** Test hook: sever the socket as if the network dropped. */
  dropSocketForTest(): void {
    this.signaling?.dropForTest();
  }

  private handleMessage(msg: ServerMessage, iceServers: RTCIceServer[]): void {
    const store = useRadioStore.getState();
    switch (msg.t) {
      case "welcome":
        this.reconnectAttempt = 0; // session proven, not merely socket-opened
        this.setupSession(msg, iceServers);
        break;
      case "peer-joined":
        store.peerJoined(msg.peer);
        this.mesh?.addPeer(msg.peer.peerId, msg.peer.joinSeq);
        break;
      case "peer-left":
        store.peerLeft(msg.peerId);
        this.mesh?.removePeer(msg.peerId);
        break;
      case "floor-granted": {
        const accepted = store.floorGranted(msg.holder, msg.seq, this.tx.held);
        if (!accepted) break; // stale seq: skip side effects too
        this.audio.setFloorHolder(msg.holder);
        if (msg.holder === store.selfId) {
          if (this.tx.held) {
            this.tx.handleGrantedSelf();
          } else {
            // Granted after the button was already released: give it back.
            this.signaling?.send({ t: "release-floor", v: PROTOCOL_VERSION });
          }
        } else {
          const stream = this.remoteStreams.get(msg.holder);
          const callsign = store.peers[msg.holder]?.callsign;
          if (stream !== undefined && callsign !== undefined) {
            this.recorder.start(stream, callsign);
          }
        }
        break;
      }
      case "floor-released": {
        const wasSelf = store.floorHolder === store.selfId;
        const wasRemote = store.floorHolder !== null && !wasSelf;
        const accepted = store.floorReleased(msg.seq);
        if (!accepted) break;
        this.audio.setFloorHolder(null);
        this.tx.handleReleased(msg.reason, wasSelf);
        if (wasRemote) {
          this.audio.rogerBeep();
          void this.recorder.stop().then((entry) => {
            if (entry !== null) {
              useRadioStore.getState().addReplay(entry);
            }
          });
        }
        break;
      }
      case "floor-denied":
        store.floorDenied(msg.reason);
        this.tx.handleDenied();
        break;
      case "status-changed":
        store.peerStatus(msg.peerId, msg.status);
        break;
      case "signal":
        void this.mesh?.handleSignal(msg.from, msg.data).catch(() => {
          // Negotiation glare the polite/impolite pattern already absorbs.
        });
        break;
      case "group-floor-granted": {
        if (this.tx.held) {
          store.announceGranted();
          this.tx.handleGrantedSelf();
        } else {
          // Granted after the key was already released: give it back.
          store.setRequesting(false);
          this.signaling?.send({ t: "release-group-floor", v: PROTOCOL_VERSION });
        }
        break;
      }
      case "group-floor-denied":
        store.announceDenied(msg.busy);
        this.tx.handleDenied();
        break;
      case "group-floor-released":
        store.announceReleased();
        this.tx.handleReleased(msg.reason, true);
        break;
      case "pong":
      case "error":
        break;
    }
  }

  private setupSession(
    msg: Extract<ServerMessage, { t: "welcome" }>,
    iceServers: RTCIceServer[],
  ): void {
    const store = useRadioStore.getState();
    store.welcome(msg.self.peerId, msg.peers, msg.floor.holder, msg.seq);
    if (this.mic === null) return;
    this.mesh?.disposeAll();
    this.remoteStreams.clear();
    this.recorder.discard();
    this.mesh = new Mesh(msg.self.joinSeq, iceServers, this.mic, {
      sendSignal: (to, data) =>
        this.signaling?.send({ t: "signal", v: PROTOCOL_VERSION, to, data }),
      onRemoteStream: (peerId, stream) => {
        this.remoteStreams.set(peerId, stream);
        this.audio.attachStream(peerId, stream);
        const prefs = useRadioStore.getState().peerAudio[peerId];
        if (prefs !== undefined) {
          this.audio.setPeerVolume(peerId, prefs.volume);
          this.audio.setPeerMuted(peerId, prefs.muted);
        }
      },
      onPeerGone: (peerId) => {
        this.remoteStreams.delete(peerId);
        this.audio.detachStream(peerId);
      },
    });
    for (const peer of msg.peers) {
      this.mesh.addPeer(peer.peerId, peer.joinSeq);
    }
    this.audio.setFloorHolder(msg.floor.holder);
    if (store.selfStatus !== "available" && store.selfStatus !== "announcing") {
      this.signaling?.send({ t: "set-status", v: PROTOCOL_VERSION, status: store.selfStatus });
    }
  }

  private handleDrop(code: number): void {
    if (this.disposed) return;
    const store = useRadioStore.getState();
    this.mesh?.disposeAll();
    this.mesh = null;
    this.remoteStreams.clear();
    this.recorder.discard();
    this.tx.cut();

    if (isFatalCloseCode(code)) {
      this.abortToJoinScreen(closeCodeMessage(code));
      return;
    }
    store.connectionLost();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer(); // a duplicate drop must never fork the loop
    const delay = backoffDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.session !== null && !this.disposed) {
        void this.start(this.session).catch(() => {
          // handleJoinFailure / handleDrop schedule the next attempt.
        });
      }
    }, delay);
  }

  private handleJoinFailure(err: unknown): void {
    if (this.disposed) return;
    if (err instanceof JoinError) {
      if (isRetryableJoinError(err, this.reconnectAttempt)) {
        useRadioStore.getState().connectionLost();
        this.scheduleReconnect();
        return;
      }
      this.abortToJoinScreen(joinErrorMessage(err));
      return;
    }
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      this.abortToJoinScreen(
        "Microphone permission denied — the radio cannot transmit without it.",
      );
      return;
    }
    // Network-level failure: retry with backoff.
    useRadioStore.getState().connectionLost();
    this.scheduleReconnect();
  }

  /** Fatal end of session: release the capture device, back to the join screen. */
  private abortToJoinScreen(message: string): void {
    const store = useRadioStore.getState();
    this.signaling?.close();
    this.signaling = null;
    this.teardownMedia();
    this.reconnectAttempt = 0;
    store.setError(message);
    store.setPhase("join");
  }

  private teardownMedia(): void {
    this.mesh?.disposeAll();
    this.mesh = null;
    this.remoteStreams.clear();
    this.recorder.discard();
    this.tx.dispose();
    this.audio.dispose();
    for (const track of this.mic?.getTracks() ?? []) {
      track.stop();
    }
    this.mic = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** leave() ran while join() was parked on an await: clean up, do not resurrect. */
  private abortIfDisposed(): boolean {
    if (!this.disposed) {
      return false;
    }
    this.teardownMedia();
    return true;
  }
}

function micSettingsOf(s: SettingsState): MicSettings {
  return {
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
  };
}

/** Singleton — one radio per tab. */
export const radio = new RadioClient();

declare global {
  interface Window {
    /** Diagnostics hook: connection stats for tests and debugging. */
    __radio?: RadioClient;
  }
}
window.__radio = radio;
