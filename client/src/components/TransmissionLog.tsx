import type { JSX } from "react";
import { radio } from "../lib/radio";
import { useRadioStore } from "../state/store";

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Last received transmissions, newest first — tap to hear one again. */
export function TransmissionLog(): JSX.Element | null {
  const replays = useRadioStore((s) => s.replays);

  if (replays.length === 0) {
    return null;
  }
  return (
    <section className="tx-log" aria-label="Received transmissions">
      <h2>Last transmissions</h2>
      <ul data-testid="tx-log">
        {replays.map((entry) => (
          <li key={entry.id} data-testid={`replay-${entry.callsign}`}>
            <span className="peer-name">{entry.callsign}</span>
            <span className="tx-meta">
              {formatTime(entry.startedAt)} · {formatDuration(entry.durationMs)}
            </span>
            <button
              type="button"
              className="mini"
              data-testid={`replay-play-${entry.callsign}`}
              onClick={() => radio.playReplay(entry)}
            >
              Replay
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
