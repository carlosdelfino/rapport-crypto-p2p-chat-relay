# Rapport P2P Signaling Relay

Serverless relay hosted on Vercel. It does **not** carry message content; it only helps peers discover each other and exchange WebRTC signaling data (SDP offers/answers and ICE candidates).

## Endpoints

- `GET /api/health` — health check.
- `POST /api/peers` — register or refresh peer online status.
- `GET /api/peers?wallet=...` — get peer info.
- `GET /api/peers` — list online peers.
- `POST /api/signal` — store a signaling envelope (offer/answer/ice).
- `GET /api/signal?topic=...&since=...&to=...` — poll signaling messages.
- `GET /api/version` — metadados da última versão de APK publicada (sem auth).
- `GET /api/stats` — estatísticas do relay: carteiras, mensagens, tópicos (sem auth).
- `GET /install` — página de redirect para `https://apk.rapport.tec.br`.
- `GET /install/manifest.json` — manifest JSON da versão atual (cache 5 min).
- `GET /stats` — página HTML com estatísticas dinâmicas e endereços de doação.

## Environment

> **Importante:** em produção/preview na Vercel, o relay **precisa de um Redis persistente** (Upstash Redis ou Vercel KV). As funções serverless da Vercel não compartilham memória entre invocações, então o armazenamento em memória não funciona na nuvem.

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

## APK Build & Distribution

O script `scripts/build-android-apk.ts` orquestra a compilação do dApp em APK e sua distribuição.

```bash
npm run apk:build       # compila o APK (EAS local)
npm run apk:upload      # envia o APK do staging ao servidor SSH
npm run apk:publish     # build + upload
npm run apk:regenerate  # regenera apenas a página /install e manifest.json
```

### Fluxo de distribuição

1. `apk:publish` compila o APK e envia para o servidor `apk_cuscuz` via SFTP.
2. A página `/install` é regenerada como redirect para `https://apk.rapport.tec.br`.
3. O `manifest.json` é gerado em `public/install/manifest.json` com a versão atual.
4. O `manifest.json` também é enviado ao servidor de APKs como fallback.
5. O dApp consulta `https://rapport-crypto-p2p-chat-relay.vercel.app/install/manifest.json` (ou `https://apk.rapport.tec.br/manifest.json` como fallback) para verificar se há atualizações.

### Variáveis de ambiente do APK

| Variável | Default | Descrição |
| :--- | :--- | :--- |
| `DAPP_DIR` | `../rapport-crypto-p2p-chat` | Caminho do dApp |
| `APK_SSH_HOST` | `apk_cuscuz` | Alias SSH do servidor |
| `APK_REMOTE_DIR` | `~/public_html/rapport/apk` | Diretório remoto |
| `APK_PUBLIC_URL` | `https://apk.rapport.tec.br` | URL pública base |
| `RELAY_INSTALL_URL` | `https://rapport-crypto-p2p-chat-relay.vercel.app/install` | URL da página /install no relay |
| `EAS_PROFILE` | `preview` | Perfil do eas.json |
