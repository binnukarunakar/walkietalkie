import { useEffect, useState, type JSX } from "react";
import { frequencyLabel, type SettableStatus } from "@walkietalkie/shared";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useWakeLock } from "../hooks/useWakeLock";
import { radio } from "../lib/radio";
import { useRadioStore } from "../state/store";
import { Roster } from "./Roster";
import { SettingsPanel } from "./SettingsPanel";
import { TransmissionLog } from "./TransmissionLog";

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

  const denyVisible = lastDeny !== null;

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
      <header>
        <div>
          <strong className="freq" data-testid="channel-label">
            {groupContext?.announce === true
              ? `${groupContext.groupName} · ALL CHANNELS`
              : `CH ${join.channel} · ${frequencyLabel(join.channel)}`}
          </strong>
          <span className="code-label">
            {groupContext !== null
              ? `${groupContext.announce ? "PA" : (groupContext.channelLabel ?? groupContext.groupName)} · ${join.callsign}`
              : `${join.code === 0 ? "open" : `code ${join.code}`} · ${join.callsign}`}
          </span>
        </div>
        <div className="header-actions">
          {groupContext?.announce !== true && (
            <>
              <button
                type="button"
                className="mini"
                data-testid="status-button"
                onClick={cycleStatus}
                title="Cycle status: available / busy / monitoring (listen-only)"
              >
                {selfStatus}
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
            onClick={() => setShowSettings((v) => !v)}
          >
            Settings
          </button>
          <button type="button" className="mini" data-testid="leave-button" onClick={() => radio.leave()}>
            Leave
          </button>
        </div>
      </header>

      <div className="floor-status" data-testid="floor-status" data-holder={holderName ?? ""}>
        {transmitting ? (
          <span className="on-air" data-testid="on-air">ON AIR</span>
        ) : holderName !== null ? (
          <span className="receiving" data-testid="receiving">{holderName} transmitting</span>
        ) : (
          <span className="idle">Channel clear</span>
        )}
      </div>

      {showSettings && <SettingsPanel />}

      <Roster />
      {groupContext?.announce !== true && <TransmissionLog />}

      {denyVisible && (
        <p className="deny" role="status" data-testid="floor-denied">
          {lastDeny?.busy !== undefined && lastDeny.busy.length > 0
            ? `Busy: ${lastDeny.busy.join(", ")}`
            : `Channel busy${lastDeny?.reason === "cooldown" ? " — cooldown" : ""}`}
        </p>
      )}

      <button
        type="button"
        className="ptt-button"
        data-testid="ptt-button"
        data-transmitting={transmitting}
        data-requesting={requesting}
        disabled={selfStatus === "monitoring"}
        onPointerDown={ptt.onPointerDown}
        onPointerUp={ptt.onPointerUp}
        onPointerCancel={ptt.onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {selfStatus === "monitoring"
          ? "MONITORING"
          : transmitting
            ? groupContext?.announce === true
              ? "ANNOUNCING"
              : "TRANSMITTING"
            : requesting
              ? "…"
              : groupContext?.announce === true
                ? "HOLD TO ANNOUNCE"
                : "HOLD TO TALK"}
      </button>
      <p className="hint">Hold the button or the PTT key.</p>
    </div>
  );
}
