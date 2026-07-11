/** Reconnect policy — pure so the classification rules are unit-testable. */

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * A dead session can hold our callsign until the server's heartbeat reaps it
 * (~60 s worst case); keep retrying "callsign-taken" during an automatic
 * reconnect long enough to outlive the ghost.
 */
export const MAX_CALLSIGN_TAKEN_RETRIES = 7;

/** WS close codes that mean "do not retry": auth/room-level rejections. */
const FATAL_CLOSE_CODES = new Set([4401, 4409, 4423, 4400]);

/** Synthetic close code the client uses when the socket fails liveness. */
export const CLOSE_LIVENESS_TIMEOUT = 4002;

export function isFatalCloseCode(code: number): boolean {
  return FATAL_CLOSE_CODES.has(code);
}

export function backoffDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

export interface JoinErrorLike {
  status: number;
  code: string;
}

/**
 * Should a failed POST /api/join abort the session (fatal) or feed back into
 * the backoff loop? Fatal only for definitive rejections on a fresh join;
 * during an automatic reconnect, transient server errors (5xx/429) and our
 * own ghost's "callsign-taken" are retried.
 */
export function isRetryableJoinError(err: JoinErrorLike, reconnectAttempt: number): boolean {
  if (err.status === 429 || err.status >= 500) {
    return true;
  }
  const isAutoReconnect = reconnectAttempt > 0;
  if (isAutoReconnect && err.code === "callsign-taken") {
    return reconnectAttempt <= MAX_CALLSIGN_TAKEN_RETRIES;
  }
  return false;
}
