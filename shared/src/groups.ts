import { z } from "zod";
import { CHANNEL_MAX, CHANNEL_MIN, CODE_MAX, CODE_MIN } from "./frs.js";

/**
 * Groups: a named namespace of labelled (channel, code) pairs.
 * "Stage" → CH1 (musicians) + CH2 (LED technicians). Rooms inside a group
 * are isolated from the global FRS rooms via the g/<id>/ key prefix.
 */

export const GROUP_NAME_MIN = 2;
export const GROUP_NAME_MAX = 24;
export const GROUP_LABEL_MAX = 16;
export const GROUP_CHANNELS_MIN = 2;
export const GROUP_CHANNELS_MAX = 6;
/** Announce meshes with every member: cap total upstream (≈ 32 kbps each). */
export const DEFAULT_MAX_GROUP_MEMBERS = 24;

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(GROUP_LABEL_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, "letters, digits, space, _ or - only");

export const groupChannelSchema = z.object({
  channel: z.number().int().min(CHANNEL_MIN).max(CHANNEL_MAX),
  code: z.number().int().min(CODE_MIN).max(CODE_MAX),
  label: labelSchema,
});
export type GroupChannel = z.infer<typeof groupChannelSchema>;

export const createGroupSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(GROUP_NAME_MIN)
      .max(GROUP_NAME_MAX)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, "letters, digits, space, _ or - only"),
    channels: z.array(groupChannelSchema).min(GROUP_CHANNELS_MIN).max(GROUP_CHANNELS_MAX),
  })
  .refine(
    (g) => new Set(g.channels.map((c) => `${String(c.channel)}:${String(c.code)}`)).size === g.channels.length,
    { message: "duplicate (channel, code) pairs in group" },
  );
export type CreateGroupRequest = z.infer<typeof createGroupSchema>;

/** Room key for a channel inside a group — never collides with global rooms. */
export function groupRoomKey(groupId: string, channel: number, code: number): string {
  return `g/${groupId}/${String(channel)}:${String(code)}`;
}

/** Public lobby shape returned by GET /api/groups/:id. */
export interface GroupInfo {
  groupId: string;
  name: string;
  channels: Array<GroupChannel & { occupancy: number }>;
}
