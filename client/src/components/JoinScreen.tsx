import { useEffect, useState, type FormEvent, type JSX } from "react";
import {
  CHANNEL_MAX,
  CHANNEL_MIN,
  CODE_MAX,
  CODE_MIN,
  callsignSchema,
  frequencyLabel,
} from "@walkietalkie/shared";
import { radio } from "../lib/radio";
import { useRadioStore } from "../state/store";

const OCCUPANCY_REFRESH_MS = 10_000;

export function JoinScreen(): JSX.Element {
  const join = useRadioStore((s) => s.join);
  const setJoin = useRadioStore((s) => s.setJoin);
  const error = useRadioStore((s) => s.error);
  const [submitting, setSubmitting] = useState(false);
  const [occupancy, setOccupancy] = useState<Record<string, number>>({});

  // Invite links: /?ch=3&code=7 pre-tunes the radio.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const ch = Number(params.get("ch"));
    const code = Number(params.get("code"));
    const patch: { channel?: number; code?: number } = {};
    if (Number.isInteger(ch) && ch >= CHANNEL_MIN && ch <= CHANNEL_MAX) {
      patch.channel = ch;
    }
    if (Number.isInteger(code) && code >= CODE_MIN && code <= CODE_MAX) {
      patch.code = code;
    }
    if (patch.channel !== undefined || patch.code !== undefined) {
      useRadioStore.getState().setJoin(patch);
    }
  }, []);

  // Open-channel (code 0) activity — privacy-coded crews are never listed.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/channels");
        if (!res.ok) return;
        const body = (await res.json()) as { open?: Record<string, number> };
        if (!cancelled && body.open !== undefined) {
          setOccupancy(body.open);
        }
      } catch {
        // Occupancy is decorative; the join flow works without it.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), OCCUPANCY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const callsignValid = callsignSchema.safeParse(join.callsign).success;

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!callsignValid || submitting) return;
    setSubmitting(true);
    void radio
      .join(join)
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  };

  return (
    <form className="join-screen" onSubmit={onSubmit} data-testid="join-screen">
      <h1>walkietalkie</h1>
      <p className="tagline">
        Half-duplex group voice. One transmitter at a time, like a real radio.
      </p>

      <label htmlFor="channel">
        Channel
        <select
          id="channel"
          data-testid="channel-select"
          value={join.channel}
          onChange={(e) => setJoin({ channel: Number(e.target.value) })}
        >
          {range(CHANNEL_MIN, CHANNEL_MAX).map((ch) => {
            const count = occupancy[String(ch)];
            return (
              <option key={ch} value={ch}>
                CH {ch} · {frequencyLabel(ch)}
                {count !== undefined && count > 0 ? ` · ${String(count)} on air` : ""}
              </option>
            );
          })}
        </select>
      </label>

      <label htmlFor="code">
        Privacy code
        <select
          id="code"
          data-testid="code-select"
          value={join.code}
          onChange={(e) => setJoin({ code: Number(e.target.value) })}
        >
          {range(CODE_MIN, CODE_MAX).map((c) => (
            <option key={c} value={c}>
              {c === 0 ? "0 · open" : c}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="callsign">
        Callsign
        <input
          id="callsign"
          data-testid="callsign-input"
          type="text"
          autoComplete="off"
          maxLength={16}
          placeholder="e.g. Maverick"
          value={join.callsign}
          onChange={(e) => setJoin({ callsign: e.target.value })}
        />
      </label>

      {error !== null && (
        <p className="error" role="alert" data-testid="join-error">
          {error}
        </p>
      )}

      <button type="submit" data-testid="join-button" disabled={!callsignValid || submitting}>
        {submitting ? "Tuning…" : "Tune in"}
      </button>
      <p className="hint">
        Crews on the same channel with different privacy codes never hear each other.
      </p>
    </form>
  );
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
