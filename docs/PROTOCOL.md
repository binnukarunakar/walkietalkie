# Signaling protocol

Transport: WebSocket at `/ws?token=<jwt>`. Every frame is a single JSON object
with a `t` (type) field, `v: 1` protocol version, zod-validated on receipt.
A well-formed JSON object with an unrecognized `t` gets a non-fatal
`error { code: "unknown-type" }` frame (forward compatibility). Anything else
— non-JSON, no `t`, or a **known** type with an invalid payload — is a
protocol error: the socket closes with code 4400.

## WS close codes

| Code | Meaning | Client action |
|---|---|---|
| `4400` | protocol error (malformed/invalid frame) | treat as fatal, rejoin manually |
| `4401` | token invalid, expired, or already used | request a fresh token via `/api/join` |
| `4409` | callsign taken at admission | pick another callsign (during automatic reconnect: retry — a dead ghost session clears within ~60 s) |
| `4423` | channel full at admission | pick another channel |
| `4429` | message flood: per-socket budget exceeded (burst 200, refill 50/s) | reconnect with backoff; a well-behaved client never trips this |
| `1001` | server shutting down | reconnect with backoff |

`/api/join` checks (occupancy, callsign) are **advisory** — the world can
change between token issue and WS connect, so admission re-checks
authoritatively and rejects with the codes above even for a valid token.

## Conventions

- `peerId` — server-assigned opaque id, unique per room, stable for the life
  of the socket.
- `seq` — monotonic per-room counter attached to every floor transition.
  Clients ignore any floor message with `seq` ≤ the last one seen.
- Times are server epoch ms.

## Client → server

| `t` | payload | notes |
|---|---|---|
| `request-floor` | — | ask to transmit |
| `release-floor` | — | done transmitting; no-op if not holder |
| `request-group-floor` | — | announce sessions only: atomic floor across every group channel |
| `release-group-floor` | — | announce sessions only |
| `signal` | `{ to: peerId, data: object }` | opaque SDP/ICE relay; server checks `to` is in the room and never inspects `data` |
| `set-status` | `{ status: "available" \| "busy" \| "monitoring" }` | presence; `announcing` is server-assigned to PA sessions and cannot be claimed |
| `ping` | — | keepalive; server answers `pong` |

## Server → client

| `t` | payload | notes |
|---|---|---|
| `welcome` | `{ self: Peer, peers: Peer[], floor: FloorState, seq }` | first frame after admission |
| `peer-joined` | `{ peer: Peer }` | existing members learn of the newcomer; the **newcomer** initiates offers |
| `peer-left` | `{ peerId }` | tear down that peer connection |
| `floor-granted` | `{ holder: peerId, seq, maxHoldMs }` | broadcast to all incl. holder |
| `floor-denied` | `{ reason: "busy" \| "cooldown", holder?: peerId }` | to requester only |
| `floor-released` | `{ seq, reason: "released" \| "timeout" \| "disconnected" }` | receivers play roger beep on `released`/`timeout` |
| `signal` | `{ from: peerId, data: object }` | relayed SDP/ICE |
| `status-changed` | `{ peerId, status }` | |
| `group-floor-granted` | `{ maxHoldMs }` | to the announcer: every channel granted |
| `group-floor-denied` | `{ busy: string[] }` | to the announcer: labels of busy channels; nothing was taken |
| `group-floor-released` | `{ reason }` | to the announcer; members see per-room `floor-released` |
| `pong` | — | |
| `error` | `{ code, message }` | non-fatal errors; fatal ones close the socket with a WS close code |

Announce sockets never receive per-room `floor-granted/denied/released` or
`status-changed` frames — their floor state is the `group-floor-*` trio.
Member-mode messages on an announce socket (and vice versa) earn an `error`
frame, not a close.

`Peer` = `{ peerId, callsign, status, joinSeq }`.
`FloorState` = `{ holder: peerId \| null, since?: number }`.

## Floor-control state machine (server, per room)

```
        request-floor            release-floor /
  FREE ───────────────▶ HELD ───────────────────▶ FREE
   ▲                     │        timeout(60s) /
   │                     │        holder disconnect
   └── deny(busy) ◀──────┘  (concurrent request-floor while HELD)
```

Invariants:
1. At most one holder per room at all times.
2. Every transition increments `seq` and is broadcast (except `floor-denied`,
   which is addressed to the requester).
3. A holder's disconnect always releases the floor (reason `disconnected`).
4. `maxHoldMs` (default 60 000) force-releases with reason `timeout`.
5. A 250 ms post-release cooldown per peer prevents immediate re-grab
   monopolies (deny reason `cooldown`). It applies after voluntary release
   AND after a max-hold timeout — the hold-to-timeout monopolist is the
   case it exists for.

## WebRTC negotiation

Perfect-negotiation pattern. For each peer pair, the peer with the **higher
`joinSeq` is the initiator** (newcomer offers to incumbents) and the lower
`joinSeq` is the polite peer during glare. One `sendrecv` audio transceiver
per connection; the local mic track is always attached with
`track.enabled = false` except while holding the floor.

## Join API

`POST /api/join` → `{ token }`

Request body (zod): `channel` int 1–22 · `code` int 0–38 · `callsign` string,
trimmed, 2–16 chars, first char `[A-Za-z0-9]`, remainder `[A-Za-z0-9 _-]`,
uniqueness enforced per room case-insensitively.

Errors: `400` validation · `409` callsign taken · `423` channel full ·
`429` rate-limited. Token: HS256 JWT, 60 s expiry, claims
`{ room: "<channel>:<code>", callsign }`, single-use (jti tracked until expiry).

`GET /api/ice` → `{ iceServers: RTCIceServer[] }` (STUN always; TURN only if
configured via env). `GET /healthz` → `{ ok: true, rooms, peers }`.

## Groups API

- `POST /api/groups` `{ name, channels: [{channel, code, label}] × 2–6 }` →
  `{ groupId, adminKey, name }`. Rate-limited (5/min/IP). The `adminKey` is
  shown once — it IS the admin role.
- `GET /api/groups/:id` → `{ groupId, name, channels: [{…, occupancy}] }`.
  Knowing the unguessable id is the read capability.
- `POST /api/join` accepts optional `groupId`: validates the (channel, code)
  belongs to the group and scopes the token to the namespaced room.
  Errors add `404 group-not-found` · `400 channel-not-in-group`.
- `POST /api/groups/:id/announce` `{ adminKey, callsign }` → `{ token }`
  admitting one socket to every group channel (mode `announce`). Errors:
  `403 bad-admin-key` · `423 group-too-large` (over `MAX_GROUP_MEMBERS`) ·
  `409/423` on callsign/occupancy conflicts.

Tokens carry `{ rooms: string[], callsign, mode: "member" | "announce",
group? }` — members always exactly one room; `group` is set for announce
sessions and for members of group rooms (it selects the shared joinSeq
counter). Group members draw `joinSeq` from a
group-wide counter (politeness stays a total order when an announcer spans
rooms).
