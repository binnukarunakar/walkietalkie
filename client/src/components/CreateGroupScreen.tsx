import { useState, type JSX } from "react";
import {
  CHANNEL_MAX,
  CHANNEL_MIN,
  GROUP_CHANNELS_MAX,
  GROUP_CHANNELS_MIN,
  createGroupSchema,
  frequencyLabel,
} from "@walkietalkie/shared";

interface CreateGroupScreenProps {
  onCreated: (groupId: string, adminKey: string) => void;
  onBack: () => void;
}

interface ChannelRow {
  channel: number;
  code: number;
  label: string;
}

/** Define a group: a name plus 2-6 labelled channels ("Stage": musicians…). */
export function CreateGroupScreen({ onCreated, onBack }: CreateGroupScreenProps): JSX.Element {
  const [name, setName] = useState("");
  const [rows, setRows] = useState<ChannelRow[]>([
    { channel: 1, code: 0, label: "" },
    { channel: 2, code: 0, label: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const payload = { name, channels: rows };
  const valid = createGroupSchema.safeParse(payload).success;

  const updateRow = (index: number, patch: Partial<ChannelRow>): void => {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const create = async (): Promise<void> => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`Could not create the group (${body.error ?? String(res.status)}).`);
        return;
      }
      const body = (await res.json()) as { groupId: string; adminKey: string };
      onCreated(body.groupId, body.adminKey);
    } catch {
      setError("Network error — the group was not created.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="join-screen" data-testid="create-group-screen">
      <h1>New group</h1>
      <p className="tagline">
        Name the group, then label each channel for its crew. You get an admin
        link that can announce to every channel at once.
      </p>

      <label htmlFor="group-name">
        Group name
        <input
          id="group-name"
          data-testid="group-name-input"
          type="text"
          autoComplete="off"
          maxLength={24}
          placeholder="e.g. Stage"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      {rows.map((row, i) => (
        <div className="group-row" key={i}>
          <select
            className="freq-select"
            aria-label={`Channel ${String(i + 1)} frequency`}
            value={row.channel}
            onChange={(e) => updateRow(i, { channel: Number(e.target.value) })}
          >
            {Array.from({ length: CHANNEL_MAX - CHANNEL_MIN + 1 }, (_, n) => n + CHANNEL_MIN).map(
              (ch) => (
                <option key={ch} value={ch}>
                  CH {ch} · {frequencyLabel(ch)}
                </option>
              ),
            )}
          </select>
          <input
            type="text"
            aria-label={`Channel ${String(i + 1)} crew label`}
            data-testid={`label-input-${String(i)}`}
            maxLength={16}
            placeholder={i === 0 ? "e.g. musicians" : "e.g. led-tech"}
            value={row.label}
            onChange={(e) => updateRow(i, { label: e.target.value })}
          />
          {rows.length > GROUP_CHANNELS_MIN && (
            <button
              type="button"
              className="mini"
              aria-label={`Remove channel ${String(i + 1)}`}
              onClick={() => setRows(rows.filter((_, n) => n !== i))}
            >
              Remove
            </button>
          )}
        </div>
      ))}

      {rows.length < GROUP_CHANNELS_MAX && (
        <button
          type="button"
          className="mini ghost-dashed"
          data-testid="add-channel"
          onClick={() =>
            setRows([...rows, { channel: Math.min(rows.length + 1, CHANNEL_MAX), code: 0, label: "" }])
          }
        >
          Add channel
        </button>
      )}

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn-primary"
        data-testid="create-group-button"
        disabled={!valid || submitting}
        onClick={() => void create()}
      >
        {submitting ? "Creating…" : "Create group"}
      </button>
      <button type="button" className="btn-text" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
