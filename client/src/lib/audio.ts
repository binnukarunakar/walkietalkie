import {
  playBusyBonk,
  playRogerBeep,
  playSquelchTail,
  playTalkChirp,
} from "./sounds";

/**
 * Receive-side audio graph.
 *
 *   per peer: MediaStreamSource → peerGain ─┐
 *                                           ├→ voiceBus → [radio filter] → master → out
 *   synthesized sfx (beeps, squelch) ───────────────────→ sfxBus ────────→ master
 *
 * peerGain = floorGate (only the floor holder is non-zero) × user volume ×
 * local mute — defense in depth: what the wire delivers never matters.
 * The radio-voice filter (300–3400 Hz bandpass + soft clip) colors voices
 * only; the sfx bus bypasses it so beeps stay crisp. Deafen zeroes the
 * voice bus, leaving sfx audible.
 *
 * A muted <audio> element per stream keeps WebRTC audio flowing into
 * WebAudio (required by Chrome and Safari for remote streams).
 */

interface PeerNodes {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  element: HTMLAudioElement;
  volume: number;
  muted: boolean;
}

const GAIN_RAMP_S = 0.015; // avoids clicks on open/close

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voiceBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private filterInput: GainNode | null = null;
  private filterNodes: AudioNode[] = [];
  private peers = new Map<string, PeerNodes>();
  private floorHolder: string | null = null;
  private radioFilterOn = false;
  private deafened = false;
  private receiveAnalyser: AnalyserNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micProbeTrack: MediaStreamTrack | null = null;

  /** Must be called from a user gesture (autoplay policy). */
  async resume(): Promise<void> {
    if (this.ctx === null) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.9;
      this.sfxBus.connect(this.master);

      this.voiceBus = this.ctx.createGain();
      this.filterInput = this.ctx.createGain();
      this.voiceBus.connect(this.filterInput);
      this.buildVoicePath();

      // Signal-meter tap on the incoming voice bus (pre-deafen gain would be
      // ideal, but metering what you'd HEAR is the honest reading).
      this.receiveAnalyser = this.ctx.createAnalyser();
      this.receiveAnalyser.fftSize = 512;
      this.receiveAnalyser.smoothingTimeConstant = 0.5;
      this.voiceBus.connect(this.receiveAnalyser);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  /**
   * Meter the mic on a CLONED track — track.enabled=false silences every
   * consumer (see transmit.ts), so the probe must own its enabled state.
   */
  attachMicProbe(mic: MediaStream): void {
    if (this.ctx === null || this.micAnalyser !== null) {
      return;
    }
    const original = mic.getAudioTracks()[0];
    if (original === undefined) {
      return;
    }
    this.micProbeTrack = original.clone();
    this.micProbeTrack.enabled = true;
    const source = this.ctx.createMediaStreamSource(new MediaStream([this.micProbeTrack]));
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.micAnalyser.smoothingTimeConstant = 0.5;
    source.connect(this.micAnalyser);
  }

  /** 0..1 level for the signal meter. `mic` = outgoing, else incoming. */
  level(source: "mic" | "receive"): number {
    const analyser = source === "mic" ? this.micAnalyser : this.receiveAnalyser;
    if (analyser === null) {
      return 0;
    }
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const centered = ((data[i] ?? 128) - 128) / 128;
      sum += centered * centered;
    }
    // RMS mapped through a gentle curve so speech occupies the visible range.
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }

  attachStream(peerId: string, stream: MediaStream): void {
    if (this.ctx === null || this.voiceBus === null) {
      return;
    }
    const previous = this.peers.get(peerId);
    const volume = previous?.volume ?? 1;
    const muted = previous?.muted ?? false;
    this.detachStream(peerId);

    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    void element.play().catch(() => undefined);

    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const entry: PeerNodes = { source, gain, element, volume, muted };
    gain.gain.value = this.effectiveGain(peerId, entry);
    source.connect(gain);
    gain.connect(this.voiceBus);

    this.peers.set(peerId, entry);
  }

  detachStream(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (entry !== undefined) {
      entry.source.disconnect();
      entry.gain.disconnect();
      entry.element.srcObject = null;
      this.peers.delete(peerId);
    }
  }

  setFloorHolder(peerId: string | null): void {
    this.floorHolder = peerId;
    this.applyGains();
  }

  setPeerVolume(peerId: string, volume: number): void {
    const entry = this.peers.get(peerId);
    if (entry !== undefined) {
      entry.volume = Math.min(Math.max(volume, 0), 1.5);
      this.applyGains();
    }
  }

  setPeerMuted(peerId: string, muted: boolean): void {
    const entry = this.peers.get(peerId);
    if (entry !== undefined) {
      entry.muted = muted;
      this.applyGains();
    }
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (this.voiceBus !== null && this.ctx !== null) {
      this.voiceBus.gain.setTargetAtTime(deafened ? 0 : 1, this.ctx.currentTime, GAIN_RAMP_S);
    }
  }

  setRadioFilter(on: boolean): void {
    if (this.radioFilterOn === on) {
      return;
    }
    this.radioFilterOn = on;
    this.buildVoicePath();
  }

  talkChirp(): void {
    if (this.ctx !== null && this.sfxBus !== null) playTalkChirp(this.ctx, this.sfxBus);
  }

  rogerBeep(): void {
    if (this.ctx !== null && this.sfxBus !== null) {
      playRogerBeep(this.ctx, this.sfxBus);
      playSquelchTail(this.ctx, this.sfxBus);
    }
  }

  busyBonk(): void {
    if (this.ctx !== null && this.sfxBus !== null) playBusyBonk(this.ctx, this.sfxBus);
  }

  dispose(): void {
    for (const peerId of [...this.peers.keys()]) {
      this.detachStream(peerId);
    }
    this.micProbeTrack?.stop();
    this.micProbeTrack = null;
    this.micAnalyser = null;
    this.receiveAnalyser = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.voiceBus = null;
    this.sfxBus = null;
    this.filterInput = null;
    this.filterNodes = [];
  }

  /** Rewire filterInput → (filter chain | direct) → master. */
  private buildVoicePath(): void {
    if (this.ctx === null || this.master === null || this.filterInput === null) {
      return;
    }
    this.filterInput.disconnect();
    for (const node of this.filterNodes) {
      node.disconnect();
    }
    this.filterNodes = [];

    if (!this.radioFilterOn) {
      this.filterInput.connect(this.master);
      return;
    }
    // Handheld-radio voice: telephone band + gentle saturation.
    const highpass = this.ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 300;
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 3400;
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = softClipCurve(2.2);
    const makeup = this.ctx.createGain();
    makeup.gain.value = 0.9;

    this.filterInput.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(shaper);
    shaper.connect(makeup);
    makeup.connect(this.master);
    this.filterNodes = [highpass, lowpass, shaper, makeup];
  }

  private effectiveGain(peerId: string, entry: PeerNodes): number {
    const floorOpen = peerId === this.floorHolder ? 1 : 0;
    return floorOpen * entry.volume * (entry.muted ? 0 : 1);
  }

  private applyGains(): void {
    const now = this.ctx?.currentTime ?? 0;
    for (const [id, entry] of this.peers) {
      entry.gain.gain.setTargetAtTime(this.effectiveGain(id, entry), now, GAIN_RAMP_S);
    }
  }
}

function softClipCurve(drive: number, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}

export interface MicSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_MIC_SETTINGS: MicSettings = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export async function openMicrophone(
  settings: MicSettings = DEFAULT_MIC_SETTINGS,
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...settings } });
  // PTT: the track stays attached to every peer connection but disabled
  // (silence) until the floor is granted. Enabling is instant — no
  // renegotiation on key-down.
  for (const track of stream.getAudioTracks()) {
    track.enabled = false;
  }
  return stream;
}

/** Retune processing constraints on the live track — no re-getUserMedia. */
export async function applyMicSettings(stream: MediaStream, settings: MicSettings): Promise<void> {
  for (const track of stream.getAudioTracks()) {
    try {
      await track.applyConstraints({ ...settings });
    } catch {
      // Constraint not supported on this device/browser — keep talking.
    }
  }
}
