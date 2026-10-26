![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Rapport%20P2P%20Signaling%20Relay&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.Rapport_Blockchain_Chat.relay_readme)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/Rapport_Blockchain_Chat)](https://github.com/RapportTecnologia/Rapport_Blockchain_Chat/issues)

# Rapport P2P Signaling Relay

Serverless relay hosted on Vercel. It does **not** carry message content; it only helps peers discover each other and exchange WebRTC signaling data (SDP offers/answers and ICE candidates).

## Endpoints

- `GET /` — landing page com links para as páginas e endpoints da API.
- `GET /api/health` — health check.
- `GET /api/status` — status público com cache para o ponto pulsante da dApp (RF-RELAY-12). Verifica Redis por PING, distingue cota excedida, indisponibilidade e falta de configuração; sinalização/presença/proteção são estados derivados da dependência, não testes ponta a ponta. HTTP 200 indica relatório acessível, não saúde integral. Sem autenticação, para humanos/agentes públicos. Não usa proteção Redis das rotas de negócio; não altera essas rotas. Single-flight e cache local de 60s (300s para cota), timeout 3s, CDN 60s; múltiplas instâncias/cold starts ainda fazem probes próprios. Não expõe diagnóstico bruto. Requisitos e limitações: `../rapport-crypto-p2p-chat/REQUIREMENTS.md`, RF-RELAY-12.
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
- `GET /tokens` — página HTML com o catálogo de redes, moedas nativas e tokens suportados pelo dApp, com o contexto de uso de cada ativo. Inclui Sonic mainnet (`146`) com `S`, `wS`, `WETH`, `USDC`, `EURC` bridged e `USDT` bridged, além da Sonic testnet (`14601`) com `wS` e `USDC` sem valor real.
- `GET /chat` — página HTML explicando como o dApp funciona: identidade por wallet, sinalização via relay, canal direto WebRTC e criptografia ponta a ponta.
- `GET /wallet` — página HTML explicando o dApp como wallet self-custody multichain: recebimentos (`/collect`), pagamentos (`/pay`), saldos e Pagamento Garantido (`/escrow`).
- `GET /invest` — página HTML explicando os investimentos DeFi/RWA via `/invest` (Aave, Morpho, Ondo, xStocks).
- `GET /comandos` — página HTML com o tutorial completo dos comandos do chat (`/pay`, `/collect`, `/balance`, `/escrow`, `/invest`, `/tokens`, `/coin`, `/chain`, `/faucet`, `/contact`, `/help`) e a carteira de suporte oficial para sugestões e dúvidas.
- `GET /sitemap.xml` — sitemap das páginas públicas (regenerado junto com `/install` via `apk:regenerate`/`apk:upload`).
- `GET /robots.txt` — regras de crawling apontando para o sitemap.

As páginas HTML (`/`, `/install`, `/stats`, `/ajudar`, `/escrow`, `/tokens`, `/chat`, `/wallet`, `/invest`, `/comandos`, `/suporte`, `/privacidade`, `/termes`, `/ban`, `/blog/*`) incluem SEO completo: canonical, Open Graph, Twitter Cards, JSON-LD (Schema.org), Google Analytics (`gtag.js`) e Meta Pixel (`fbevents.js`, PageView). Os assets `/favicon.png`, `/apple-touch-icon.png` e `/og-image.png` são derivados do ícone do dApp.

### Internacionalização (i18n)

Todas as páginas públicas são multilíngues. O idioma é resolvido client-side por `public/js/i18n.js` nesta ordem: `?lang=` na URL (persistido em `localStorage['rcc-lang']`), preferência salva, `navigator.languages` e, por fim, inglês como fallback. Idiomas suportados: `pt-BR` (fonte do HTML), `en`, `es`, `fr` e `ar` (`dir="rtl"`). A barra de bandeiras no topo troca o idioma sem reload.

- Textos estáticos usam `data-i18n` / `data-i18n-html` / `data-i18n-attr` / `data-i18n-param-*`; o engine captura um snapshot do pt-BR e aplica o dicionário de `/js/i18n/<lang>.js` (carregado sob demanda).
- Textos renderizados em JS (`/stats`, `/escrow`) usam `I18N.t(key)` + `I18N.locale` e escutam o evento `i18n:change` para re-renderizar.
- A página `/install` é gerada por `scripts/build-android-apk.ts` — ao editar marcação i18n dela, altere `renderInstallPage()` e rode `npm run apk:regenerate`; editar o HTML gerado diretamente é perdido na próxima publicação de APK.
- Para adicionar um idioma: crie `public/js/i18n/<code>.js` (`I18N.register(...)`), adicione-o em `LANGS` no `i18n.js` e no snippet de detecção de cada página + `renderInstallPage()`, e declare o `hreflang`.

### Contatos e assets

- Carteira oficial de suporte/doações dev: `0x7010A4C4c189AB421028a622e2A2e623f432d18e`.
- WhatsApp oficial do suporte: `+55 85 98520-5490` (`https://wa.me/5585985205490`). Links `wa.me` nas páginas ganham `?text=` com a página de origem via `public/js/contact.js`; endereços com `data-addr` copiam ao clique.
- `public/images/rapport-logo.png` e `public/images/carlos-delfino-stand.jpg`: fornecidos pelo proprietário; `public/images/editorial/*.webp`: imagens editoriais geradas por IA; os depoimentos da home usam nomes e retratos fictícios (não são avaliações reais de clientes).

## Proteção anti-flood e contrato da API

- Cada cliente pode armazenar somente um sinal a cada 1000ms, somando todos os tópicos e tipos (`data`, ACK, handshake, ICE, offer, answer, chat_request). Carteiras com assinatura verificada têm cota própria; requisições sem assinatura usam cota por IP, nunca a identidade apenas declarada.
- A **11ª tentativa** POST `/api/signal` em **1000ms móveis**, inclusive tentativas inválidas/recusadas, suspende o IP. A suspensão é `min(30s × reincidência², 1h)`: 30s, 120s, 270s etc. Novo flood durante suspensão aumenta a penalidade no máximo uma vez por segundo; uma consulta isolada não a renova. Histórico reinicia após 24h sem abuso.
- Cota HTTP separada: 600 requisições/IP em janela fixa de 60s nas rotas signal, peers, stats, health, ban, tx-report, escrow-request e onramp-session. Mais de 30 falhas de validação/assinatura de signal por minuto móvel também suspendem. OPTIONS não conta como mensagem. O onramp também compartilha o orçamento HTTP; não foram alteradas operações on-chain.
- Respostas 429 contêm `code`, `message`, `details.reason`, `details.retry_after_ms`, `details.cooldown_until`, `next_step` e alias `nest_step`. O header `Retry-After` é exposto por CORS. Aguarde antes de reenviar; sinais recusados não são gravados.
- IP vem do header confiável da plataforma Vercel ou do socket local. Não há confiança automática em `X-Forwarded-For` no servidor local. IPv4 mapeado e IPv6 são normalizados. **Usuários atrás de NAT compartilham cotas por IP.**
- Redis usa scripts Lua curtos e atômicos, com TTL de 25h; não há fallback silencioso para memória em produção. Falha da proteção retorna 503 e orientação de espera. Memória local é somente para desenvolvimento/testes, com quantidade de entradas e histórico limitados.
- Health check não cria mensagens de teste nem faz leitura completa de tópicos. Logs de penalidade registram transições com hash parcial de identificação, sem IP literal, conteúdo, assinatura ou segredo.
- É mitigação de DoS de aplicação, não proteção contra saturação de rede/DDoS distribuído. WAF e limites de borda exigem configuração operacional separada; nada é implantado automaticamente.

Contrato: [OpenAPI JSON](public/openapi.json). Visualizadores disponíveis em `/swagger` e `/redoc`, somente leitura, sem submissão de requisições nem validação remota do contrato. Assets públicos dos visualizadores têm versões fixas e SRI; sem CDN, o link JSON continua disponível. A autenticação de POST continua condicionada a `RELAY_REQUIRE_SIGNATURE=true`; assinaturas fornecidas sempre são verificadas. Humanos e agentes usam a mesma política, sem privilégio de bypass.

Requisitos compartilhados: [RF-RELAY-01 a RF-RELAY-10](../rapport-crypto-p2p-chat/REQUIREMENTS.md). Testes do backend: `npm test` (Node/tsx); a prova de atomicidade exige `redis-server` e `redis-cli` locais e cria instância isolada sem persistência nem porta TCP. Nunca executar testes contra Redis de produção.

### Mitigação do onramp e auditoria residual

O onramp valida strings e limita `assets.tokens`, `assets.chains` e `assets.pairs` a 16 entradas antes de chamar o SDK; cada identificador limita-se a 64 caracteres. Requisições com Content-Length acima de 8192 são recusadas. Campos desconhecidos não são encaminhados. Erros não incluem diagnóstico do SDK, token de sessão, appUserId ou endereço nos logs/respostas de falha.

Isso mitiga a entrada excessiva em Zod, mas **não corrige a dependência upstream**: `@circle-fin/onramp-kit` 1.0.6 ainda fixa Zod 3.25.67 e o advisory exige 4.6.6+. Não foi forçado override de major nem upgrade sem benefício de segurança. A auditoria `npm audit --omit=dev` continua com **2 findings altos no relay**; publicação permanece bloqueada. No aplicativo foram autorizadas correções parciais em Solana/brace-expansion, com findings residuais documentados nos requisitos. Nenhuma transação ou sessão real foi criada nos testes.

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

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
