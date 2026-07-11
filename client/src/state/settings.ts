import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  VOX_THRESHOLD_DEFAULT_DB,
  VOX_THRESHOLD_MAX_DB,
  VOX_THRESHOLD_MIN_DB,
} from "../lib/vox";

export const RELEASE_DELAY_DEFAULT_MS = 200;
export const RELEASE_DELAY_MAX_MS = 1000;

export interface SettingsState {
  /** Receive-side 300–3400 Hz bandpass + soft clip ("radio voice"). */
  radioVoice: boolean;
  /** Anti-clip: keep transmitting this long after PTT release. */
  releaseDelayMs: number;
  /** KeyboardEvent.code used for push-to-talk. */
  pttKey: string;
  /** Voice-activated transmit (experimental, off by default). */
  voxEnabled: boolean;
  voxThresholdDb: number;
  /** getUserMedia processing constraints, applied live via applyConstraints. */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;

  setRadioVoice: (on: boolean) => void;
  setReleaseDelayMs: (ms: number) => void;
  setPttKey: (code: string) => void;
  setVoxEnabled: (on: boolean) => void;
  setVoxThresholdDb: (db: number) => void;
  setMicProcessing: (patch: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      radioVoice: false,
      releaseDelayMs: RELEASE_DELAY_DEFAULT_MS,
      pttKey: "Space",
      voxEnabled: false,
      voxThresholdDb: VOX_THRESHOLD_DEFAULT_DB,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,

      setRadioVoice: (radioVoice) => set({ radioVoice }),
      setReleaseDelayMs: (ms) =>
        set({ releaseDelayMs: clamp(Math.round(ms), 0, RELEASE_DELAY_MAX_MS) }),
      setPttKey: (pttKey) => set({ pttKey }),
      setVoxEnabled: (voxEnabled) => set({ voxEnabled }),
      setVoxThresholdDb: (db) =>
        set({ voxThresholdDb: clamp(Math.round(db), VOX_THRESHOLD_MIN_DB, VOX_THRESHOLD_MAX_DB) }),
      setMicProcessing: (patch) => set(patch),
    }),
    { name: "walkietalkie-settings", version: 1 },
  ),
);
