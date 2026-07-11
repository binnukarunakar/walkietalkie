# walkietalkie

A walkie-talkie in the browser. Half-duplex group voice over a WebRTC
peer-to-peer mesh — one person transmits, everyone else listens, exactly like
a radio. A single Node server does signaling and enforces who has the floor.
No accounts, no database, no SFU, no audio ever touches the server.

- **FRS radio semantics** — pick channel 1–22 (real FRS frequencies) and a
  privacy code 0–38. Your room is the (channel, code) pair; crews on the same
  channel with different codes never hear each other.
- **Push to talk** — hold the on-screen button or the spacebar. The server
  grants the floor to one transmitter at a time; everyone else gets the busy
  bonk, like keying over someone on a real handheld.
- **Radio sound design** — roger beep, squelch tail, busy tone, all
  synthesized in WebAudio. Optional "radio voice" filter (300–3400 Hz bandpass
  + soft clip) if you want it to sound like a real rig.
- **Instant replay** — the last transmissions are ring-buffered in your
  browser; tap to re-hear the one you missed. Nothing is stored server-side.
- **VOX mode** — optional voice-activated transmit with adjustable threshold.
- **Ephemeral by design** — callsigns instead of accounts; a room ceases to
  exist when the last peer leaves.

## How it works

```
Browser A ──╮
Browser B ──┼── WSS signaling ── Node server (rooms · floor control · JWT)
Browser C ──╯
Audio: A ⇄ B, A ⇄ C, B ⇄ C   direct P2P (SRTP)
```

PTT is half-duplex, so at most one peer streams at a time — which is why a
mesh of up to 9 peers works without an SFU. Full design in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), wire format in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Run it

```bash
npm install
npm run dev        # server on :8080, Vite client on :5173 (proxied)
```

Open http://localhost:5173 in two tabs, join the same channel + code with two
callsigns, hold space in one tab.

## Production

```bash
npm run build      # builds client, server serves it statically
npm start          # single process on :8080
# or
docker build -t walkietalkie . && docker run -p 8080:8080 walkietalkie
```

Deploy anywhere Node + WebSockets run (Fly.io, Railway, Render, a VPS).
Not Vercel — the signaling socket is long-lived.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | listen port |
| `SESSION_SECRET` | generated at boot | JWT signing key (set it if you run replicas) |
| `MAX_CHANNEL_SIZE` | `9` | mesh cap per room |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | unset | optional TURN relay for hostile NATs |

## Test

```bash
npm test           # server unit tests (floor state machine, rooms, tokens, protocol)
npm run e2e        # Playwright: two browser contexts, fake mics, real WebRTC
npm run lint
```

## License

MIT
