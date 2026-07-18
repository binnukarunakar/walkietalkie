import { useEffect, useState, type JSX } from "react";
import { callsignSchema, frequencyLabel, type GroupInfo } from "@walkietalkie/shared";
import { radio } from "../lib/radio";
import { fetchGroupInfo } from "../lib/signaling";
import { useRadioStore } from "../state/store";

const REFRESH_MS = 10_000;

interface GroupLobbyProps {
  groupId: string;
  adminKey: string | null;
}

/** Landing for /?group=<id>[&admin=<key>]: pick a channel, or announce. */
export function GroupLobby({ groupId, adminKey }: GroupLobbyProps): JSX.Element {
  const join = useRadioStore((s) => s.join);
  const setJoin = useRadioStore((s) => s.setJoin);
  const error = useRadioStore((s) => s.error);
  const [info, setInfo] = useState<GroupInfo | null | "loading">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const fetched = await fetchGroupInfo(groupId);
      if (!cancelled) {
        setInfo(fetched);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [groupId]);

  if (info === "loading") {
    return (
      <div className="connecting" data-testid="group-loading">
        <p>Finding group…</p>
      </div>
    );
  }
  if (info === null) {
    return (
      <div className="join-screen" data-testid="group-missing">
        <h1>Group not found</h1>
        <p className="tagline">
          Groups expire when idle. Ask whoever shared the link to create a new one.
        </p>
      </div>
    );
  }

  const callsignValid = callsignSchema.safeParse(join.callsign).success;

  const joinChannel = (channel: number, code: number, label: string): void => {
    if (!callsignValid || submitting) return;
    setSubmitting(true);
    void radio
      .join({
        channel,
        code,
        callsign: join.callsign,
        groupId,
        groupName: info.name,
        channelLabel: label,
      })
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  };

  const announce = (): void => {
    if (!callsignValid || submitting || adminKey === null) return;
    setSubmitting(true);
    void radio
      .announce({ groupId, adminKey, callsign: join.callsign, groupName: info.name })
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  };

  const copyMemberLink = (): void => {
    const url = `${location.origin}/?group=${encodeURIComponent(groupId)}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="join-screen" data-testid="group-lobby">
      <h1>{info.name}</h1>
      <p className="tagline">
        Group frequency plan — pick your channel{adminKey !== null ? ", or announce to all" : ""}.
      </p>

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

      <ul className="lobby-channels">
        {info.channels.map((c) => (
          <li key={`${String(c.channel)}:${String(c.code)}`}>
            <div className="lobby-channel-info">
              <span className="peer-name">{c.label}</span>
              <span className="tx-meta">
                CH {c.channel} · {frequencyLabel(c.channel)}
                {c.occupancy > 0 ? ` · ${String(c.occupancy)} on air` : ""}
              </span>
            </div>
            <button
              type="button"
              data-testid={`join-${c.label}`}
              disabled={!callsignValid || submitting}
              onClick={() => joinChannel(c.channel, c.code, c.label)}
            >
              Join
            </button>
          </li>
        ))}
      </ul>

      {error !== null && (
        <p className="error" role="alert" data-testid="join-error">
          {error}
        </p>
      )}

      {adminKey !== null && (
        <button
          type="button"
          className="announce-cta"
          data-testid="announce-button"
          disabled={!callsignValid || submitting}
          onClick={announce}
        >
          Announce to all channels
        </button>
      )}
      <button type="button" className="mini" data-testid="copy-group-link" onClick={copyMemberLink}>
        {copied ? "Copied" : "Copy member link"}
      </button>
    </div>
  );
}
