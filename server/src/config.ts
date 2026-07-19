import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_MAX_CHANNEL_SIZE, DEFAULT_MAX_GROUP_MEMBERS } from "@walkietalkie/shared";

/** `.env` files often ship `NAME=` — treat empty strings as unset. */
const emptyToUndefined = (v: unknown): unknown => (v === "" ? undefined : v);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  SESSION_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  MAX_CHANNEL_SIZE: z.coerce.number().int().min(2).max(16).default(DEFAULT_MAX_CHANNEL_SIZE),
  /** Announce meshes with every group member — cap total upstream cost. */
  MAX_GROUP_MEMBERS: z.coerce.number().int().min(2).max(60).default(DEFAULT_MAX_GROUP_MEMBERS),
  /** Floor max-hold override (ms). Mainly for tests; production uses the protocol default. */
  MAX_HOLD_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1000).optional()),
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  TURN_USERNAME: z.preprocess(emptyToUndefined, z.string().optional()),
  TURN_CREDENTIAL: z.preprocess(emptyToUndefined, z.string().optional()),
  JOIN_RATE_MAX: z.coerce.number().int().min(1).default(10),
  /** Only enable behind a reverse proxy — otherwise clients can spoof X-Forwarded-For. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  CLIENT_DIST: z.preprocess(emptyToUndefined, z.string().optional()),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export interface AppConfig {
  port: number;
  host: string;
  /** HS256 signing key. Generated per boot unless SESSION_SECRET is set. */
  sessionSecret: Uint8Array;
  sessionSecretGenerated: boolean;
  maxChannelSize: number;
  maxGroupMembers: number;
  maxHoldMs: number | undefined;
  stunUrls: string[];
  turn: { url: string; username: string; credential: string } | null;
  /** POST /api/join requests allowed per IP per minute. */
  joinRateMax: number;
  trustProxy: boolean;
  clientDist: string | null;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  const turnFieldsSet = [parsed.TURN_URL, parsed.TURN_USERNAME, parsed.TURN_CREDENTIAL].filter(
    (v) => v !== undefined && v !== "",
  ).length;
  if (turnFieldsSet !== 0 && turnFieldsSet !== 3) {
    throw new Error("TURN_URL, TURN_USERNAME and TURN_CREDENTIAL must be set together");
  }

  const generated = parsed.SESSION_SECRET === undefined;
  const secret = generated
    ? randomBytes(32)
    : new TextEncoder().encode(parsed.SESSION_SECRET as string);

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    sessionSecret: secret,
    sessionSecretGenerated: generated,
    maxChannelSize: parsed.MAX_CHANNEL_SIZE,
    maxGroupMembers: parsed.MAX_GROUP_MEMBERS,
    maxHoldMs: parsed.MAX_HOLD_MS,
    stunUrls: parsed.STUN_URLS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    turn:
      turnFieldsSet === 3
        ? {
            url: parsed.TURN_URL as string,
            username: parsed.TURN_USERNAME as string,
            credential: parsed.TURN_CREDENTIAL as string,
          }
        : null,
    joinRateMax: parsed.JOIN_RATE_MAX,
    trustProxy: parsed.TRUST_PROXY === "true",
    clientDist: parsed.CLIENT_DIST ?? null,
    logLevel: parsed.LOG_LEVEL,
  };
}
