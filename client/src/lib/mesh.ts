import { PROTOCOL_VERSION, type ClientMessage } from "@walkietalkie/shared";

export interface MeshCallbacks {
  sendSignal: (to: string, data: Record<string, unknown>) => void;
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onPeerGone: (peerId: string) => void;
}

interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

/**
 * One RTCPeerConnection per remote peer, wired with the perfect-negotiation
 * pattern (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example).
 * The peer with the LOWER joinSeq is polite (incumbents yield to newcomers).
 */
class PeerLink {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;

  constructor(
    readonly peerId: string,
    private readonly polite: boolean,
    iceServers: RTCIceServer[],
    localStream: MediaStream,
    private readonly callbacks: MeshCallbacks,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });

    for (const track of localStream.getAudioTracks()) {
      this.pc.addTrack(track, localStream);
    }

    this.pc.onnegotiationneeded = () => {
      void (async () => {
        try {
          this.makingOffer = true;
          await this.pc.setLocalDescription();
          if (this.pc.localDescription !== null) {
            this.sendPayload({ description: this.pc.localDescription.toJSON() as RTCSessionDescriptionInit });
          }
        } finally {
          this.makingOffer = false;
        }
      })();
    };

    this.pc.onicecandidate = (event) => {
      this.sendPayload({ candidate: event.candidate === null ? null : event.candidate.toJSON() });
    };

    this.pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream !== undefined) {
        this.callbacks.onRemoteStream(this.peerId, stream);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === "failed") {
        this.pc.restartIce();
      }
    };
  }

  async handleSignal(data: SignalPayload): Promise<void> {
    if (data.description !== undefined) {
      const description = data.description;
      // Canonical readiness check: an offer arriving while we apply a remote
      // ANSWER is not glare — the state goes stable as soon as it lands.
      const readyForOffer =
        !this.makingOffer &&
        (this.pc.signalingState === "stable" || this.isSettingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;

      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        return;
      }
      this.isSettingRemoteAnswerPending = description.type === "answer";
      try {
        await this.pc.setRemoteDescription(description);
      } finally {
        this.isSettingRemoteAnswerPending = false;
      }
      if (description.type === "offer") {
        await this.pc.setLocalDescription();
        if (this.pc.localDescription !== null) {
          this.sendPayload({ description: this.pc.localDescription.toJSON() as RTCSessionDescriptionInit });
        }
      }
    } else if (data.candidate !== undefined) {
      try {
        await this.pc.addIceCandidate(data.candidate ?? undefined);
      } catch (err) {
        if (!this.ignoreOffer) {
          throw err;
        }
      }
    }
  }

  private sendPayload(payload: SignalPayload): void {
    this.callbacks.sendSignal(this.peerId, payload as Record<string, unknown>);
  }

  dispose(): void {
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.close();
  }
}

/** Manages the full mesh: one PeerLink per remote peer. */
export class Mesh {
  private links = new Map<string, PeerLink>();

  constructor(
    private readonly selfJoinSeq: number,
    private readonly iceServers: RTCIceServer[],
    private readonly localStream: MediaStream,
    private readonly callbacks: MeshCallbacks,
  ) {}

  addPeer(peerId: string, peerJoinSeq: number): void {
    if (this.links.has(peerId)) {
      return;
    }
    const polite = this.selfJoinSeq < peerJoinSeq;
    this.links.set(
      peerId,
      new PeerLink(peerId, polite, this.iceServers, this.localStream, this.callbacks),
    );
  }

  removePeer(peerId: string): void {
    const link = this.links.get(peerId);
    if (link !== undefined) {
      link.dispose();
      this.links.delete(peerId);
      this.callbacks.onPeerGone(peerId);
    }
  }

  async handleSignal(from: string, data: Record<string, unknown>): Promise<void> {
    const link = this.links.get(from);
    if (link !== undefined) {
      await link.handleSignal(data as SignalPayload);
    }
  }

  /** Connection-level stats for diagnostics and tests. */
  async inboundAudioBytes(): Promise<number> {
    let total = 0;
    for (const link of this.links.values()) {
      const stats = await link.pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          total += (report as { bytesReceived?: number }).bytesReceived ?? 0;
        }
      });
    }
    return total;
  }

  disposeAll(): void {
    for (const [peerId, link] of this.links) {
      link.dispose();
      this.callbacks.onPeerGone(peerId);
    }
    this.links.clear();
  }
}

export function signalMessage(to: string, data: Record<string, unknown>): ClientMessage {
  return { t: "signal", v: PROTOCOL_VERSION, to, data };
}
