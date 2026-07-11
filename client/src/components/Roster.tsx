import type { JSX } from "react";
import { radio } from "../lib/radio";
import { useRadioStore } from "../state/store";

/** Channel roster: who's on, who's talking, per-peer volume and mute. */
export function Roster(): JSX.Element {
  const join = useRadioStore((s) => s.join);
  const selfId = useRadioStore((s) => s.selfId);
  const selfStatus = useRadioStore((s) => s.selfStatus);
  const peers = useRadioStore((s) => s.peers);
  const peerAudio = useRadioStore((s) => s.peerAudio);
  const floorHolder = useRadioStore((s) => s.floorHolder);

  return (
    <ul className="roster" data-testid="roster">
      <li data-self="true" data-speaking={floorHolder !== null && floorHolder === selfId}>
        <span className="peer-name">
          {join.callsign} <em>(you)</em>
        </span>
        {selfStatus !== "available" && <em className="peer-status">{selfStatus}</em>}
      </li>
      {Object.values(peers)
        .sort((a, b) => a.joinSeq - b.joinSeq)
        .map((peer) => {
          const prefs = peerAudio[peer.peerId] ?? { volume: 1, muted: false };
          return (
            <li
              key={peer.peerId}
              data-testid={`peer-${peer.callsign}`}
              data-speaking={floorHolder === peer.peerId}
            >
              <span className="peer-name">{peer.callsign}</span>
              {peer.status !== "available" && <em className="peer-status">{peer.status}</em>}
              <span className="peer-controls">
                <input
                  type="range"
                  min={0}
                  max={150}
                  value={Math.round(prefs.volume * 100)}
                  aria-label={`${peer.callsign} volume`}
                  onChange={(e) => radio.setPeerVolume(peer.peerId, Number(e.target.value) / 100)}
                />
                <button
                  type="button"
                  className="mini"
                  aria-pressed={prefs.muted}
                  data-testid={`mute-${peer.callsign}`}
                  onClick={() => radio.setPeerMuted(peer.peerId, !prefs.muted)}
                >
                  {prefs.muted ? "Unmute" : "Mute"}
                </button>
              </span>
            </li>
          );
        })}
    </ul>
  );
}
