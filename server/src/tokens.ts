import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const TOKEN_TTL_SECONDS = 60;
const ALG = "HS256";
const MAX_ROOMS_PER_TOKEN = 8;

export type SessionMode = "member" | "announce";

export interface SessionClaims {
  /** Rooms this socket is admitted to. Members get one; announcers get all of a group's. */
  rooms: string[];
  callsign: string;
  mode: SessionMode;
  /** Set for announce sessions: the group whose joinSeq counter to draw from. */
  group?: string;
}

/**
 * Issues and verifies short-lived, single-use, room-scoped join tokens.
 * Single-use is enforced by tracking jti until natural expiry.
 */
export class TokenService {
  private readonly usedJtis = new Map<string, number>();

  constructor(
    private readonly secret: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(claims: SessionClaims): Promise<string> {
    const jwt = new SignJWT({
      rooms: claims.rooms,
      callsign: claims.callsign,
      mode: claims.mode,
      ...(claims.group !== undefined ? { group: claims.group } : {}),
    })
      .setProtectedHeader({ alg: ALG })
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`);
    return jwt.sign(this.secret);
  }

  /**
   * Verifies signature + expiry and consumes the jti. Returns null on any
   * failure — callers treat the token as invalid without distinguishing why.
   */
  async verifyAndConsume(token: string): Promise<SessionClaims | null> {
    this.sweep();
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: [ALG] });
      const { jti, rooms, callsign, mode, group, exp } = payload;
      if (
        typeof jti !== "string" ||
        typeof callsign !== "string" ||
        typeof exp !== "number" ||
        (mode !== "member" && mode !== "announce") ||
        !Array.isArray(rooms) ||
        rooms.length === 0 ||
        rooms.length > MAX_ROOMS_PER_TOKEN ||
        !rooms.every((r): r is string => typeof r === "string") ||
        (mode === "member" && rooms.length !== 1) ||
        (group !== undefined && typeof group !== "string")
      ) {
        return null;
      }
      if (this.usedJtis.has(jti)) {
        return null;
      }
      this.usedJtis.set(jti, exp * 1000);
      const claims: SessionClaims = { rooms, callsign, mode };
      if (typeof group === "string") {
        claims.group = group;
      }
      return claims;
    } catch {
      return null;
    }
  }

  /** Drop jtis whose tokens have expired anyway. */
  private sweep(): void {
    const now = this.now();
    for (const [jti, expMs] of this.usedJtis) {
      if (expMs <= now) {
        this.usedJtis.delete(jti);
      }
    }
  }
}
