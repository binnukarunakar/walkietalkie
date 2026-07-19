import type { JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listItem } from "../lib/motion";
import { radio } from "../lib/radio";
import { useRadioStore } from "../state/store";
import { Slider } from "./ui/Slider";

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
      <AnimatePresence initial={false}>
        {Object.values(peers)
          .sort((a, b) => a.joinSeq - b.joinSeq)
          .map((peer) => {
            const prefs = peerAudio[peer.peerId] ?? { volume: 1, muted: false };
            return (
              <motion.li
                key={peer.peerId}
                layout="position"
                variants={listItem}
                initial="hidden"
                animate="visible"
                exit="exit"
                data-testid={`peer-${peer.callsign}`}
                data-speaking={floorHolder === peer.peerId}
                data-muted={prefs.muted}
              >
                <span className="peer-name">{peer.callsign}</span>
                {peer.status !== "available" && (
                  <em className="peer-status">{peer.status}</em>
                )}
                <span className="peer-controls">
                  <Slider
                    aria-label={`${peer.callsign} volume`}
                    min={0}
                    max={150}
                    value={Math.round(prefs.volume * 100)}
                    onChange={(v) => radio.setPeerVolume(peer.peerId, v / 100)}
                    className="peer-volume"
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
              </motion.li>
            );
          })}
      </AnimatePresence>
    </ul>
  );
}
