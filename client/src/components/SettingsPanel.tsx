import { useState, type JSX } from "react";
import { VOX_THRESHOLD_MAX_DB, VOX_THRESHOLD_MIN_DB } from "../lib/vox";
import { RELEASE_DELAY_MAX_MS, useSettings } from "../state/settings";
import { useRadioStore } from "../state/store";
import { Slider } from "./ui/Slider";
import { Switch } from "./ui/Switch";

/** Audio and transmit preferences. Persisted across sessions. */
export function SettingsPanel(): JSX.Element {
  const settings = useSettings();
  const voxAutoDisabled = useRadioStore((s) => s.voxAutoDisabled);
  const [capturingKey, setCapturingKey] = useState(false);

  return (
    <div className="settings" data-testid="settings-panel">
      <div className="row">
        <label htmlFor="radio-voice">
          Radio voice
          <small>Incoming voices sound like a real handset (300–3400 Hz, soft clip)</small>
        </label>
        <Switch
          id="radio-voice"
          data-testid="radio-voice-toggle"
          checked={settings.radioVoice}
          onChange={settings.setRadioVoice}
        />
      </div>

      <div className="row">
        <label htmlFor="vox">
          VOX
          <small>Voice-activated transmit (experimental)</small>
        </label>
        <Switch
          id="vox"
          data-testid="vox-toggle"
          checked={settings.voxEnabled}
          onChange={settings.setVoxEnabled}
        />
      </div>
      {voxAutoDisabled && (
        <p className="note" role="status">
          VOX turned itself off: three transmissions in a row hit the max hold
          time, which usually means an open mic. Check your surroundings and
          threshold.
        </p>
      )}
      {settings.voxEnabled && (
        <div className="row slider-row">
          <label>
            Threshold
            <small>{settings.voxThresholdDb} dB</small>
          </label>
          <Slider
            aria-label="VOX threshold"
            min={VOX_THRESHOLD_MIN_DB}
            max={VOX_THRESHOLD_MAX_DB}
            value={settings.voxThresholdDb}
            onChange={settings.setVoxThresholdDb}
          />
        </div>
      )}

      <div className="row slider-row">
        <label>
          Release tail
          <small>{settings.releaseDelayMs} ms — last words don't clip</small>
        </label>
        <Slider
          aria-label="Release tail"
          min={0}
          max={RELEASE_DELAY_MAX_MS}
          step={20}
          value={settings.releaseDelayMs}
          onChange={settings.setReleaseDelayMs}
        />
      </div>

      <div className="row">
        <label>
          PTT key (push-to-talk)
          <small>{settings.pttKey}</small>
        </label>
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

      <fieldset>
        <legend>Microphone processing</legend>
        <div className="row">
          <label htmlFor="ec">Echo cancellation</label>
          <Switch
            id="ec"
            checked={settings.echoCancellation}
            onChange={(v) => settings.setMicProcessing({ echoCancellation: v })}
          />
        </div>
        <div className="row">
          <label htmlFor="ns">Noise suppression</label>
          <Switch
            id="ns"
            checked={settings.noiseSuppression}
            onChange={(v) => settings.setMicProcessing({ noiseSuppression: v })}
          />
        </div>
        <div className="row">
          <label htmlFor="agc">Auto gain</label>
          <Switch
            id="agc"
            checked={settings.autoGainControl}
            onChange={(v) => settings.setMicProcessing({ autoGainControl: v })}
          />
        </div>
      </fieldset>
    </div>
  );
}
