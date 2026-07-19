import { useState, type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listItem } from "../lib/motion";
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
  const [playingId, setPlayingId] = useState<string | null>(null);

  if (replays.length === 0) {
    return null;
  }
  return (
    <section className="tx-log" aria-label="Received transmissions">
      <h2>Last transmissions</h2>
      <ul data-testid="tx-log">
        <AnimatePresence initial={false}>
          {replays.map((entry) => (
            <motion.li
              key={entry.id}
              layout="position"
              variants={listItem}
              initial="hidden"
              animate="visible"
              exit="exit"
              data-testid={`replay-${entry.callsign}`}
              data-playing={playingId === entry.id}
            >
              <span className="peer-name">{entry.callsign}</span>
              <span className="tx-meta">
                {formatTime(entry.startedAt)} · {formatDuration(entry.durationMs)}
              </span>
              <button
                type="button"
                className="mini"
                data-testid={`replay-play-${entry.callsign}`}
                onClick={() => {
                  setPlayingId(entry.id);
                  radio.playReplay(entry);
                  window.setTimeout(() => {
                    setPlayingId((current) => (current === entry.id ? null : current));
                  }, entry.durationMs);
                }}
              >
                {playingId === entry.id ? "Playing" : "Replay"}
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}
