import type { JoinError } from "./signaling";

export function joinErrorMessage(err: JoinError): string {
  switch (err.code) {
    case "callsign-taken":
      return "That callsign is already on this channel. Pick another.";
    case "full":
      return "Channel is full (mesh cap). Try another channel.";
    case "invalid-request":
      return "Invalid channel, code, or callsign.";
    case "group-not-found":
      return "This group no longer exists — groups expire when idle.";
    case "channel-not-in-group":
      return "That channel is not part of this group.";
    case "bad-admin-key":
      return "Admin key rejected — ask for a fresh admin link.";
    case "group-too-large":
      return "Too many people in the group to announce to (bandwidth cap).";
    default:
      return `Could not join (${String(err.status)}).`;
  }
}

export function closeCodeMessage(code: number): string {
  switch (code) {
    case 4401:
      return "Session rejected — token expired. Join again.";
    case 4409:
      return "That callsign is already on this channel.";
    case 4423:
      return "Channel is full.";
    default:
      return "Connection closed by the server.";
  }
}
