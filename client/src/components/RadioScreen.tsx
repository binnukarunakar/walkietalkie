import { useEffect, useState, type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { frequencyLabel, type SettableStatus } from "@walkietalkie/shared";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useWakeLock } from "../hooks/useWakeLock";
import { pressScale, riseChild, shake, transitions } from "../lib/motion";
import { radio } from "../lib/radio";
import { useSettings } from "../state/settings";
import { useRadioStore } from "../state/store";
import { Roster } from "./Roster";
import { SettingsPanel } from "./SettingsPanel";
import { SignalMeter } from "./SignalMeter";
import { TransmissionLog } from "./TransmissionLog";
import { Sheet } from "./ui/Sheet";

const STATUS_CYCLE: SettableStatus[] = ["available", "busy", "monitoring"];
const DENY_VISIBLE_MS = 1500;

export function RadioScreen(): JSX.Element {
  const join = useRadioStore((s) => s.join);
  const selfId = useRadioStore((s) => s.selfId);
  const selfStatus = useRadioStore((s) => s.selfStatus);
  const deafened = useRadioStore((s) => s.deafened);
  const peers = useRadioStore((s) => s.peers);
  const floorHolder = useRadioStore((s) => s.floorHolder);
  const transmitting = useRadioStore((s) => s.transmitting);
  const requesting = useRadioStore((s) => s.requesting);
  const lastDeny = useRadioStore((s) => s.lastDeny);
  const clearDeny = useRadioStore((s) => s.clearDeny);
  const groupContext = useRadioStore((s) => s.groupContext);
  const pttKey = useSettings((s) => s.pttKey);
  const ptt = usePushToTalk();
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState(false);
  useWakeLock();

  // The banner is state-driven, so it needs a timer to leave again.
  useEffect(() => {
    if (lastDeny === null) return;
    const timer = window.setTimeout(clearDeny, DENY_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [lastDeny, clearDeny]);

  const holderName =
    floorHolder === null
      ? null
      : floorHolder === selfId
        ? "You"
        : (peers[floorHolder]?.callsign ?? "…");

  const announce = groupContext?.announce === true;

  const cycleStatus = (): void => {
    const next =
      STATUS_CYCLE[(STATUS_CYCLE.indexOf(selfStatus as SettableStatus) + 1) % STATUS_CYCLE.length] ??
      "available";
    radio.setStatus(next);
  };

  const copyInvite = (): void => {
    const url =
      groupContext !== null
        ? `${location.origin}/?group=${encodeURIComponent(groupContext.groupId)}`
        : `${location.origin}/?ch=${String(join.channel)}&code=${String(join.code)}`;
    const shareData = { title: "walkietalkie channel", url };
    if (typeof navigator.share === "function" && navigator.canShare?.(shareData) === true) {
      void navigator.share(shareData).catch(() => undefined);
      return;
    }
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="radio-screen" data-testid="radio-screen">
      <motion.header variants={riseChild}>
        <div>
          <strong className="freq" data-testid="channel-label">
            {announce
              ? `${groupContext.groupName} · ALL CHANNELS`
              : `CH ${join.channel} · ${frequencyLabel(join.channel)}`}
          </strong>
          <span className="code-label">
            {groupContext !== null
              ? `${announce ? "Announce" : (groupContext.channelLabel ?? groupContext.groupName)} · ${join.callsign}`
              : `${join.code === 0 ? "open" : `code ${join.code}`} · ${join.callsign}`}
          </span>
        </div>
        <div className="header-actions">
          {!announce && (
            <>
              <button
                type="button"
                className="status-chip"
                data-testid="status-button"
                role="status"
                onClick={cycleStatus}
                title="Tap to cycle: Available / Busy / Monitoring (listen-only)"
              >
                <span className="status-dot" data-status={selfStatus} aria-hidden="true" />
                {selfStatus.charAt(0).toUpperCase() + selfStatus.slice(1)}
              </button>
              <button
                type="button"
                className="mini"
                aria-pressed={deafened}
                data-testid="deafen-button"
                onClick={() => radio.setDeafened(!deafened)}
              >
                {deafened ? "Undeafen" : "Deafen"}
              </button>
            </>
          )}
          <button type="button" className="mini" data-testid="invite-button" onClick={copyInvite}>
            {copied ? "Copied" : "Invite"}
          </button>
          <button
            type="button"
            className="mini"
            data-testid="settings-button"
            aria-pressed={showSettings}
            onClick={() => setShowSettings(true)}
          >
            Settings
          </button>
          <button type="button" className="mini" data-testid="leave-button" onClick={() => radio.leave()}>
            Leave
          </button>
        </div>
      </motion.header>

      <motion.div
        variants={riseChild}
        className="floor-status"
        data-testid="floor-status"
        data-holder={holderName ?? ""}
        data-announce={announce && transmitting}
      >
        <AnimatePresence mode="wait" initial={false}>
          {transmitting ? (
            <motion.span
              key="tx"
              className="on-air"
              data-testid="on-air"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transitions.fast}
            >
              {announce ? "ON AIR · ALL CHANNELS" : "ON AIR"}
            </motion.span>
          ) : holderName !== null ? (
            <motion.span
              key={`rx-${holderName}`}
              className="receiving"
              data-testid="receiving"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transitions.fast}
            >
              RECEIVING · {holderName}
            </motion.span>
          ) : (
            <motion.span
              key="idle"
              className="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transitions.fast}
            >
              Channel clear
            </motion.span>
          )}
        </AnimatePresence>
        <SignalMeter />
      </motion.div>

      <Sheet open={showSettings} onOpenChange={setShowSettings} title="Settings">
        <SettingsPanel />
      </Sheet>

      <Roster />
      {!announce && <TransmissionLog />}

      <AnimatePresence>
        {lastDeny !== null && (
          <motion.p
            className="deny"
            role="status"
            data-testid="floor-denied"
            variants={shake}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {lastDeny.busy !== undefined && lastDeny.busy.length > 0
              ? `Busy: ${lastDeny.busy.join(", ")}`
              : `Channel busy${lastDeny.reason === "cooldown" ? " — cooldown" : ""}`}
          </motion.p>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        className="ptt-button"
        data-testid="ptt-button"
        data-transmitting={transmitting}
        data-requesting={requesting}
        data-busy={holderName !== null && !transmitting}
        data-announce={announce && transmitting}
        disabled={selfStatus === "monitoring"}
        whileTap={pressScale}
        transition={transitions.spring}
        onPointerDown={ptt.onPointerDown}
        onPointerUp={ptt.onPointerUp}
        onPointerCancel={ptt.onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {selfStatus === "monitoring"
          ? "MONITORING"
          : transmitting
            ? announce
              ? "ANNOUNCING"
              : "TRANSMITTING"
            : requesting
              ? "…"
              : holderName !== null
                ? "CHANNEL BUSY"
                : announce
                  ? "HOLD TO ANNOUNCE"
                  : "HOLD TO TALK"}
      </motion.button>
      <p className="hint">
        {transmitting
          ? "Release to stop."
          : holderName !== null
            ? "Channel busy — wait for the transmission to end."
            : `Hold the button — or hold ${pttKey}.`}
      </p>
    </div>
  );
}
