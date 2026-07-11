import { useState, type JSX } from "react";
import {
  VOX_THRESHOLD_MAX_DB,
  VOX_THRESHOLD_MIN_DB,
} from "../lib/vox";
import { RELEASE_DELAY_MAX_MS, useSettings } from "../state/settings";
import { useRadioStore } from "../state/store";

/** Audio and transmit preferences. Persisted across sessions. */
export function SettingsPanel(): JSX.Element {
  const settings = useSettings();
  const voxAutoDisabled = useRadioStore((s) => s.voxAutoDisabled);
  const [capturingKey, setCapturingKey] = useState(false);

  return (
    <section className="settings" data-testid="settings-panel" aria-label="Settings">
      <h2>Settings</h2>

      <label className="row">
        <input
          type="checkbox"
          checked={settings.radioVoice}
          data-testid="radio-voice-toggle"
          onChange={(e) => settings.setRadioVoice(e.target.checked)}
        />
        Radio voice (300–3400 Hz + soft clip on received audio)
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={settings.voxEnabled}
          data-testid="vox-toggle"
          onChange={(e) => settings.setVoxEnabled(e.target.checked)}
        />
        VOX — voice-activated transmit (experimental)
      </label>
      {voxAutoDisabled && (
        <p className="note" role="status">
          VOX turned itself off: three transmissions in a row hit the max hold time,
          which usually means an open mic. Check your surroundings and threshold.
        </p>
      )}
      {settings.voxEnabled && (
        <label className="row slider">
          Threshold {settings.voxThresholdDb} dB
          <input
            type="range"
            min={VOX_THRESHOLD_MIN_DB}
            max={VOX_THRESHOLD_MAX_DB}
            value={settings.voxThresholdDb}
            onChange={(e) => settings.setVoxThresholdDb(Number(e.target.value))}
          />
        </label>
      )}

      <label className="row slider">
        Release tail {settings.releaseDelayMs} ms
        <input
          type="range"
          min={0}
          max={RELEASE_DELAY_MAX_MS}
          step={20}
          value={settings.releaseDelayMs}
          onChange={(e) => settings.setReleaseDelayMs(Number(e.target.value))}
        />
      </label>

      <div className="row">
        <span>PTT key: {settings.pttKey}</span>
        <button
          type="button"
          className="mini"
          onClick={() => setCapturingKey(true)}
          onKeyDown={(e) => {
            if (!capturingKey) return;
            e.preventDefault();
            settings.setPttKey(e.code);
            setCapturingKey(false);
          }}
          onBlur={() => setCapturingKey(false)}
        >
          {capturingKey ? "Press a key…" : "Change"}
        </button>
      </div>

      <fieldset className="row">
        <legend>Microphone processing</legend>
        <label>
          <input
            type="checkbox"
            checked={settings.echoCancellation}
            onChange={(e) => settings.setMicProcessing({ echoCancellation: e.target.checked })}
          />
          Echo cancellation
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.noiseSuppression}
            onChange={(e) => settings.setMicProcessing({ noiseSuppression: e.target.checked })}
          />
          Noise suppression
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.autoGainControl}
            onChange={(e) => settings.setMicProcessing({ autoGainControl: e.target.checked })}
          />
          Auto gain
        </label>
      </fieldset>
    </section>
  );
}
