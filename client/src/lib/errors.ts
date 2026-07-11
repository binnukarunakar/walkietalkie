import type { JoinError } from "./signaling";

export function joinErrorMessage(err: JoinError): string {
  switch (err.code) {
    case "callsign-taken":
      return "That callsign is already on this channel. Pick another.";
    case "full":
      return "Channel is full (mesh cap). Try another channel.";
    case "invalid-request":
      return "Invalid channel, code, or callsign.";
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
