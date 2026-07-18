import type { GroupContext, JoinParams } from "../state/store";
import { requestAnnounceToken, requestJoinToken } from "./signaling";

/** Everything needed to (re)establish a session, member or announcer. */
export type SessionParams =
  | ({ kind: "member"; groupName?: string; channelLabel?: string } & JoinParams)
  | { kind: "announce"; groupId: string; adminKey: string; callsign: string; groupName: string };

export async function acquireToken(session: SessionParams): Promise<string> {
  if (session.kind === "announce") {
    return requestAnnounceToken(session.groupId, session.adminKey, session.callsign);
  }
  return requestJoinToken(session.channel, session.code, session.callsign, session.groupId);
}

export function contextOf(session: SessionParams): GroupContext | null {
  if (session.kind === "announce") {
    return {
      groupId: session.groupId,
      groupName: session.groupName,
      channelLabel: null,
      announce: true,
    };
  }
  if (session.groupId !== undefined) {
    return {
      groupId: session.groupId,
      groupName: session.groupName ?? "",
      channelLabel: session.channelLabel ?? null,
      announce: false,
    };
  }
  return null;
}

/** The join fields a member session persists for reconnect. */
export function memberJoinParams(session: SessionParams): JoinParams | null {
  return session.kind === "member" ? session : null;
}
