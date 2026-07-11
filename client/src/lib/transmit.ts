import { useSettings } from "../state/settings";
import { useRadioStore } from "../state/store";
import type { AudioGraph } from "./audio";
import { VoxGate, rmsDb } from "./vox";

export interface TransmitDeps {
  sendRequestFloor: () => void;
  sendReleaseFloor: () => void;
  audio: AudioGraph;
}

const VOX_SAMPLE_INTERVAL_MS = 60;
const VOX_FFT_SIZE = 1024;

/**
 * Everything between "the user wants to talk" and "the mic track is hot":
 * PTT press/release, the release-delay tail (mic stays hot briefly after
 * keyup so last words aren't clipped), and the VOX runtime. The floor
 * protocol itself lives in RadioClient; this module only reacts to its
 * outcomes (granted / released / denied).
 */
export class TransmitController {
  /** True while the user (or VOX) wants to transmit. A floor grant that
   * arrives after release must NOT open the mic. */
  held = false;

  private mic: MediaStream | null = null;
  private releaseTimer: number | null = null;
  private vox: VoxRuntime | null = null;

  constructor(private readonly deps: TransmitDeps) {}

  attachMic(stream: MediaStream): void {
    this.mic = stream;
    if (useSettings.getState().voxEnabled) {
      this.startVox();
    }
  }

  press(): void {
    const store = useRadioStore.getState();
    this.held = true;
    if (this.releaseTimer !== null && store.transmitting) {
      // Re-keyed inside the release tail: still on air, just cancel the release.
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      return;
    }
    if (
      store.phase !== "onair" ||
      store.transmitting ||
      store.requesting ||
      store.selfStatus === "monitoring" // listen-only by choice
    ) {
      return;
    }
    store.setRequesting(true);
    this.deps.sendRequestFloor();
  }

  release(): void {
    this.held = false;
    const store = useRadioStore.getState();
    const tailMs = useSettings.getState().releaseDelayMs;
    if (store.transmitting && tailMs > 0) {
      this.releaseTimer ??= window.setTimeout(() => {
        this.releaseTimer = null;
        if (!this.held) {
          this.finishRelease();
        }
      }, tailMs);
      return;
    }
    this.finishRelease();
  }

  /** Server granted us the floor and the key is still down. */
  handleGrantedSelf(): void {
    this.setMicEnabled(true);
    this.deps.audio.talkChirp();
  }

  /** Floor released (any holder). Reason matters only for our own VOX takes. */
  handleReleased(reason: string, wasSelf: boolean): void {
    this.setMicEnabled(false);
    if (wasSelf && reason === "timeout") {
      this.vox?.noteForcedTimeout();
    }
  }

  handleDenied(): void {
    this.deps.audio.busyBonk();
    this.vox?.noteDenied();
  }

  micEnabled(): boolean {
    return this.mic?.getAudioTracks().some((t) => t.enabled) ?? false;
  }

  setMicEnabled(enabled: boolean): void {
    for (const track of this.mic?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  setVoxEnabled(enabled: boolean): void {
    if (enabled) {
      useRadioStore.getState().setVoxAutoDisabled(false);
      this.startVox();
    } else {
      this.stopVox();
    }
  }

  /** Force-stop transmission state without waiting for the tail (drops, leave). */
  cut(): void {
    this.held = false;
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.setMicEnabled(false);
  }

  dispose(): void {
    this.cut();
    this.stopVox();
    this.mic = null;
  }

  private finishRelease(): void {
    const store = useRadioStore.getState();
    this.setMicEnabled(false);
    if (store.transmitting || store.requesting) {
      store.setRequesting(false);
      this.deps.sendReleaseFloor();
    }
  }

  private startVox(): void {
    if (this.mic === null || this.vox !== null) {
      return;
    }
    this.vox = new VoxRuntime(this.mic, {
      onKey: () => this.press(),
      onUnkey: () => this.release(),
      onAutoDisable: () => {
        useSettings.getState().setVoxEnabled(false);
        useRadioStore.getState().setVoxAutoDisabled(true);
        this.stopVox();
        this.release();
      },
    });
  }

  private stopVox(): void {
    this.vox?.dispose();
    this.vox = null;
  }
}

interface VoxRuntimeCallbacks {
  onKey: () => void;
  onUnkey: () => void;
  onAutoDisable: () => void;
}

/** Samples the mic level and drives the pure VoxGate decision core. */
class VoxRuntime {
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analysisTrack: MediaStreamTrack | null;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly gate: VoxGate;
  private readonly timer: number;

  constructor(
    mic: MediaStream,
    private readonly callbacks: VoxRuntimeCallbacks,
  ) {
    this.gate = new VoxGate({
      thresholdDb: useSettings.getState().voxThresholdDb,
    });
    // `track.enabled = false` silences the track for EVERY consumer,
    // including a local analyser — so analysis runs on a clone, whose
    // enabled state is independent of the transmitted track's.
    const original = mic.getAudioTracks()[0];
    this.analysisTrack = original?.clone() ?? null;
    if (this.analysisTrack !== null) {
      this.analysisTrack.enabled = true;
    }
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(
      new MediaStream(this.analysisTrack === null ? [] : [this.analysisTrack]),
    );
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = VOX_FFT_SIZE;
    this.source.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);

    this.timer = window.setInterval(() => this.tick(), VOX_SAMPLE_INTERVAL_MS);
  }

  noteForcedTimeout(): void {
    if (this.gate.noteForcedTimeout() === "disabled") {
      this.callbacks.onAutoDisable();
    }
  }

  noteDenied(): void {
    this.gate.noteDenied();
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.source.disconnect();
    this.analysisTrack?.stop();
    void this.ctx.close().catch(() => undefined);
  }

  private tick(): void {
    this.analyser.getFloatTimeDomainData(this.samples);
    const decision = this.gate.sample(rmsDb(this.samples), Date.now());
    if (decision === "key") {
      this.callbacks.onKey();
    } else if (decision === "unkey") {
      this.callbacks.onUnkey();
    }
  }
}
