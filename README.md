# Rapport P2P Signaling Relay

Serverless relay hosted on Vercel. It does **not** carry message content; it only helps peers discover each other and exchange WebRTC signaling data (SDP offers/answers and ICE candidates).

## Endpoints

- `GET /api/health` — health check.
- `POST /api/peers` — register or refresh peer online status.
- `GET /api/peers?wallet=...` — get peer info.
- `GET /api/peers` — list online peers.
- `POST /api/signal` — store a signaling envelope (offer/answer/ice).
- `GET /api/signal?topic=...&since=...&to=...` — poll signaling messages.

## Environment

Copy `.env.example` to `.env` and fill in Upstash Redis credentials.

```bash
cp .env.example .env
```

## Run locally

```bash
cd relay
npm install
npx vercel dev
```

## Deploy

```bash
cd relay
npx vercel --prod
```

Then set the environment variables in the Vercel dashboard.

## Security notes

- Messages are end-to-end encrypted by the mobile app using X25519 + ChaCha20-Poly1305 before being sent over WebRTC.
- The relay only stores encrypted signaling metadata and peer multiaddrs.
- Set `RELAY_REQUIRE_SIGNATURE=true` to require EIP-191 signatures on `POST` requests.
