# Architecture

Browser walkie-talkie: half-duplex group voice over a WebRTC peer-to-peer mesh,
with a single Node.js server doing signaling, room management, and floor control.
No SFU, no database, no accounts.

```
Browser A ──╮
Browser B ──┼── WSS /ws ── Node server (Fastify + ws)
Browser C ──╯              rooms · floor control · token auth

Audio:  A ⇄ B, A ⇄ C, B ⇄ C   (direct P2P, SRTP/DTLS)
```

## Why a mesh and not an SFU

PTT is half-duplex: the floor-control state machine guarantees at most one
transmitter per channel at any moment. An SFU earns its complexity when N
people stream simultaneously; here N=1 by protocol. A full mesh of ~9 peers
with a single active sender costs the speaker ~8 upstream audio streams
(Opus ≈ 32 kbps each ≈ 256 kbps total) — fine on any real connection. The
trade-off is a hard channel-size cap (`MAX_CHANNEL_SIZE`, default 9),
which matches the product: small-crew radio, not Discord.

## Components

| Component | Tech | Responsibility |
|---|---|---|
| `server/` | Node 24, TypeScript, Fastify, `ws`, `jose`, `zod` | Join API (token issue), WS signaling relay, room registry, floor-control state machine, ICE config endpoint, static hosting of the built client |
| `client/` | Vite, React, TypeScript, zustand | UI, WebRTC mesh management, PTT/VOX capture, WebAudio receive chain (radio filter, beeps), transmission log + replay |
| `e2e/` | Playwright | Multi-browser-context integration tests with fake media devices |

One deployable artifact: the server container serves the built client and
exposes `/api/*` + `/ws`. Works anywhere Node + WebSockets work (Fly.io,
Railway, Render, a VPS). Not Vercel — long-lived WebSockets.

## Channels = FRS radio semantics

Channels are modeled on real FRS radio: **channel 1–22** (each mapped to its
real FRS frequency for display, e.g. CH 3 · 462.6125 MHz) plus a **privacy
code 0–38** (CTCSS-style). A room is the `(channel, code)` pair — two crews on
channel 3 with different privacy codes never hear each other, exactly like
real handhelds. Code 0 is the open channel. No channel discovery or listing:
you know the channel and code, or you don't. Identity is an ephemeral,
user-chosen callsign — no accounts, nothing stored server-side after the last
peer leaves.

## Join flow

1. `POST /api/join` `{channel, code, callsign}` — zod-validated, rate-limited.
   Server checks occupancy < cap, callsign collision, then returns a 60-second
   room-scoped JWT (HS256 via `jose`; secret from `SESSION_SECRET` env or
   generated at boot for single-instance deployments).
2. Client opens `wss://…/ws?token=…`. Server verifies the token, admits the
   socket to the room, sends `welcome` (self id, roster, current floor state).
3. Newcomer initiates a WebRTC offer to every existing peer (perfect
   negotiation; politeness decided by join sequence). SDP/ICE ride the WS as
   opaque `signal` relay messages — the server never parses them.

## Transmit path (the core loop)

- `getUserMedia` runs once on join; the local mic track is attached to every
  peer connection **with `track.enabled = false`**.
- Hold PTT → client sends `request-floor`. Server: floor free → broadcast
  `floor-granted(to)`; floor held → `floor-denied(busy)` (client plays the
  busy bonk).
- On grant, the holder flips `track.enabled = true`. No renegotiation, so
  keyup-to-audio latency is one WS round-trip.
- Release (or 60 s max-hold timeout, or holder disconnect) → server broadcasts
  `floor-released`; receivers synthesize the roger beep locally.
- Defense in depth: receivers only play audio from the current floor holder,
  regardless of what arrives.

## Receive chain (WebAudio, per peer)

```
RTCPeerConnection track ─ MediaStreamSource ─ per-user gain (volume/mute)
  ─ [optional radio filter: 300–3400 Hz bandpass + waveshaper + noise floor]
  ─ master gain ─ destination
```

Roger beep / squelch tail / busy bonk are synthesized with oscillator + noise
envelopes — zero audio asset files. Each incoming transmission is captured by
a `MediaRecorder` ring buffer (last 10, in memory only) for instant replay.

## Resilience

- **WS drop**: exponential backoff reconnect (1 s → 30 s), fresh token via
  `/api/join` (channel/code/callsign retained client-side), roster resync.
- **Peer ICE failure**: ICE restart via renegotiation; hard teardown +
  re-offer after 10 s. STUN defaults to public Google STUN; TURN is optional
  via `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` env, surfaced through
  `GET /api/ice` — no credentials ever ship to the client except through that
  endpoint at runtime.
- **Floor races**: every floor transition carries a monotonic `seq`; clients
  discard stale transitions.

## Groups (v1.2)

A **group** is a named namespace of labelled channels — "Stage" containing
CH1 *musicians* and CH2 *led-tech*. Rooms inside a group are keyed
`g/<groupId>/<ch>:<code>`, fully isolated from the global FRS rooms. The
registry is in-memory with TTL/idle GC: groups, like rooms, cease to exist
when nobody needs them.

Roles are **capabilities, not accounts**: creating a group returns an
unguessable admin key; whoever holds the admin URL is a group admin, and
sharing that URL appoints co-admins. Members get a plain group link and
pick a channel in the lobby.

**Announce (PA mode):** an admin can transmit to every channel at once. One
WebSocket is admitted into all child rooms; the group floor is atomic (every
channel free, or the announce is denied naming the busy crews); members
simply see a normal transmitter key up in their channel. The announcer is
transmit-only — receive gating across N rooms is deliberately sidestepped,
like a real PA. Media stays pure P2P: the announcer meshes with every
member, so announce is capped by `MAX_GROUP_MEMBERS` (default 24 ≈ 768 kbps
upstream at 32 kbps Opus). Rooms in a group share one joinSeq counter so
perfect-negotiation politeness remains a coherent total order across the
announcer's merged mesh.

## What this deliberately is not

- Not an SFU app — channel size is capped by design.
- Not E2EE — media is P2P (SRTP), but floor control and membership are
  server-trusted. An E2EE claim would require a threat model and design doc
  first (see project rules).
- Not a message store — nothing persists server-side; replay buffers live in
  the receiving browser only.
