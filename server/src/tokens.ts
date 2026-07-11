import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const TOKEN_TTL_SECONDS = 60;
const ALG = "HS256";

export interface RoomClaims {
  room: string;
  callsign: string;
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

  async issue(claims: RoomClaims): Promise<string> {
    return new SignJWT({ room: claims.room, callsign: claims.callsign })
      .setProtectedHeader({ alg: ALG })
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  /**
   * Verifies signature + expiry and consumes the jti. Returns null on any
   * failure — callers treat the token as invalid without distinguishing why.
   */
  async verifyAndConsume(token: string): Promise<RoomClaims | null> {
    this.sweep();
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: [ALG] });
      const { jti, room, callsign, exp } = payload;
      if (
        typeof jti !== "string" ||
        typeof room !== "string" ||
        typeof callsign !== "string" ||
        typeof exp !== "number"
      ) {
        return null;
      }
      if (this.usedJtis.has(jti)) {
        return null;
      }
      this.usedJtis.set(jti, exp * 1000);
      return { room, callsign };
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
