# Rapport P2P Signaling Relay

Serverless relay hosted on Vercel. It does **not** carry message content; it only helps peers discover each other and exchange WebRTC signaling data (SDP offers/answers and ICE candidates).

## Endpoints

- `GET /` — landing page com links para as páginas e endpoints da API.
- `GET /api/health` — health check.
- `POST /api/peers` — register or refresh peer online status.
- `GET /api/peers?wallet=...` — get peer info.
- `GET /api/peers` — list online peers.
- `POST /api/signal` — store a signaling envelope (offer/answer/ice).
- `GET /api/signal?topic=...&since=...&to=...` — poll signaling messages.
- `GET /api/version` — metadados da última versão de APK publicada (sem auth).
- `GET /api/stats` — estatísticas do relay: carteiras, mensagens de chat, chats, sinais de sistema, volume transacionado por ativo e por rede (`financial`, reportado anonimamente pelo dApp) e demanda por escrow em redes sem contrato (`escrowDemand`). Sem auth, sem endereços de carteira.
- `POST /api/tx-report` — o dApp reporta volume transacionado de forma anônima (rede, ativo, montante, tipo) após cada transação on-chain confirmada; dedup por `reportId`. Sem auth, sem carteiras.
- `GET /install` — página HTML que lista os APKs disponíveis para download (links diretos para `apk.rapport.tec.br`).
- `GET /install/manifest.json` — manifest JSON da versão atual (cache 5 min).
- `GET /stats` — página HTML com estatísticas dinâmicas do relay.
- `GET /ajudar` — página HTML "Como Ajudar": formas de apoiar o projeto e endereços de doação (gestão Rapport e carteira do desenvolvedor).
- `GET /escrow` — página HTML com tutorial do escrow arbitrado on-chain e manifest de contratos (`/escrow/contracts.json`).
- `GET /tokens` — página HTML com o catálogo de redes, moedas nativas e tokens suportados pelo dApp, com o contexto de uso de cada ativo.
- `GET /chat` — página HTML explicando como o dApp funciona: identidade por wallet, sinalização via relay, canal direto WebRTC e criptografia ponta a ponta.
- `GET /wallet` — página HTML explicando o dApp como wallet self-custody multichain: recebimentos (`/collect`), pagamentos (`/pay`), saldos e Pagamento Garantido (`/escrow`).
- `GET /invest` — página HTML explicando os investimentos DeFi/RWA via `/invest` (Aave, Morpho, Ondo, xStocks).
- `GET /comandos` — página HTML com o tutorial completo dos comandos do chat (`/pay`, `/collect`, `/balance`, `/escrow`, `/invest`, `/tokens`, `/coin`, `/chain`, `/faucet`, `/contact`, `/help`) e a carteira de suporte oficial para sugestões e dúvidas.
- `GET /sitemap.xml` — sitemap das páginas públicas (regenerado junto com `/install` via `apk:regenerate`/`apk:upload`).
- `GET /robots.txt` — regras de crawling apontando para o sitemap.

As páginas HTML (`/`, `/install`, `/stats`, `/ajudar`, `/escrow`, `/tokens`, `/chat`, `/wallet`, `/invest`, `/comandos`) incluem SEO completo: canonical, Open Graph, Twitter Cards, JSON-LD (Schema.org) e Google Analytics (`gtag.js`). Os assets `/favicon.png`, `/apple-touch-icon.png` e `/og-image.png` são derivados do ícone do dApp.

### Internacionalização (i18n)

Todas as páginas públicas são multilíngues. O idioma é resolvido client-side por `public/js/i18n.js` nesta ordem: `?lang=` na URL (persistido em `localStorage['rcc-lang']`), preferência salva, `navigator.languages` e, por fim, inglês como fallback. Idiomas suportados: `pt-BR` (fonte do HTML), `en`, `es`, `fr` e `ar` (`dir="rtl"`). A barra de bandeiras no topo troca o idioma sem reload.

- Textos estáticos usam `data-i18n` / `data-i18n-html` / `data-i18n-attr` / `data-i18n-param-*`; o engine captura um snapshot do pt-BR e aplica o dicionário de `/js/i18n/<lang>.js` (carregado sob demanda).
- Textos renderizados em JS (`/stats`, `/escrow`) usam `I18N.t(key)` + `I18N.locale` e escutam o evento `i18n:change` para re-renderizar.
- A página `/install` é gerada por `scripts/build-android-apk.ts` — ao editar marcação i18n dela, altere `renderInstallPage()` e rode `npm run apk:regenerate`; editar o HTML gerado diretamente é perdido na próxima publicação de APK.
- Para adicionar um idioma: crie `public/js/i18n/<code>.js` (`I18N.register(...)`), adicione-o em `LANGS` no `i18n.js` e no snippet de detecção de cada página + `renderInstallPage()`, e declare o `hreflang`.

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

## Testes

```bash
npm run typecheck        # tsc --noEmit
npm run test:e2e         # Playwright E2E (chromium + mobile-chromium)
npm run test:e2e:ui      # Playwright em modo UI
npm run test:e2e:headed  # Playwright com browser visível
```

Os testes E2E (`e2e/*.spec.ts`) validam as páginas estáticas servidas por
`scripts/static-server.mjs`, que reproduz a semântica de `cleanUrls` da Vercel
sobre `public/`. Requer Node.js >= 20. Os browsers do Playwright usam o Chrome
do sistema (`channel: 'chrome'`) quando o download via `npx playwright install`
não está disponível.

## APK Build & Distribution

O script `scripts/build-android-apk.ts` orquestra a compilação do dApp em APK e sua distribuição.

```bash
npm run apk:build       # compila o APK (EAS local)
npm run apk:upload      # envia o APK do staging ao servidor SSH
npm run apk:publish     # build + upload
npm run apk:regenerate  # regenera apenas a página /install e manifest.json
npm run apk:clean       # remove APKs disponíveis, preservando apenas o mais recente
```

Flags opcionais de `apk:upload` / `apk:publish`:

```bash
npm run apk:upload -- --file <nome.apk>        # envia um APK específico do staging
npm run apk:upload -- --force                  # reenvia mesmo que o APK já exista no servidor
npm run apk:upload -- --comment "texto"        # comentário sobre a versão (máx 280 chars)
```

O comentário informado via `--comment` descreve o que a versão disponibiliza e é
exibido no card correspondente da página `/install`, além de ficar registrado no
manifest local (`assets/apk-manifest.json`) e no `manifest.json` público
(`public/install/manifest.json`, também servido por `https://apk.rapport.tec.br`).

### Fluxo de distribuição

1. `apk:publish` compila o APK e envia para o servidor `apk_rapport` via SFTP.
2. A página `/install` é regenerada como índice de APKs com links de download diretos para `https://apk.rapport.tec.br/{filename}`.
3. O `manifest.json` é gerado em `public/install/manifest.json` com a versão atual.
4. O `manifest.json` também é enviado ao servidor de APKs como fallback.
5. O dApp consulta `https://rapport-crypto-p2p-chat-relay.vercel.app/install/manifest.json` (ou `https://apk.rapport.tec.br/manifest.json` como fallback) para verificar se há atualizações.

### Variáveis de ambiente do APK

| Variável | Default | Descrição |
| :--- | :--- | :--- |
| `DAPP_DIR` | `../rapport-crypto-p2p-chat` | Caminho do dApp |
| `APK_SSH_HOST` | `apk_rapport` | Alias SSH do servidor |
| `APK_REMOTE_DIR` | `~/public_html/rapport/apk` | Diretório remoto |
| `APK_PUBLIC_URL` | `https://apk.rapport.tec.br` | URL pública base |
| `RELAY_INSTALL_URL` | `https://rapport-crypto-p2p-chat-relay.vercel.app/install` | URL da página /install no relay |
| `EAS_PROFILE` | `preview` | Perfil do eas.json |
