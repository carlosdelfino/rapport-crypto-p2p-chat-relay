![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Cloudflare%20Relay&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.relay_cloudflare-relay)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Cloudflare Relay — signaling + presence sem Upstash

Relay de sinalização P2P e registro de presença do Rapport Crypto Chat
implementado em **Cloudflare Workers + Durable Objects**, substituindo o
caminho quente do relay Vercel/Upstash.

## Motivação

O relay Vercel consome ~5 comandos Upstash Redis por `GET /api/signal`
(proteção anti-abuse, banlist, leitura da fila). Com polling a cada 1,5s
por tópico, apenas 2 peers geram ~576k–1,1M comandos/dia, esgotando a
franquia em menos de um mês. Neste módulo todo o caminho quente vive na
memória/storage de **um único Durable Object global**: zero comandos
Redis por requisição e WebSocket com push real-time que elimina a
necessidade de polling.

## Arquitetura

- `src/index.ts` — Worker entry: CORS e guarda de credencial do cliente
  (`X-Rapport-Client-Key`, ou `?key=` em `/ws`), roteamento para o DO.
- `src/hub.ts` — `SignalingHub` (Durable Object, instância global `hub`):
  sinais por tópico, presença (`PeerRecord`, TTL 5min), TTL de sinais 1h,
  sweep via alarm a cada 15min, broadcast WebSocket por tag de tópico.
- `src/protection.ts` — anti-abuse em memória (10 sinais/s, 600 req/min,
  cooldown progressivo até 1h, strikes decaem em 24h) — semântica
  equivalente ao `decideProtection` do relay Vercel, mas sem EVAL Redis.
- `src/banlist.ts` — overrides por env (`BANNED_WALLETS`) + leitura
  on-chain `isBanned` na BanQuadraticDAO (Polygon) com cache em memória
  de 60s.
- `src/auth.ts` — verificação EIP-191 via viem, janela de timestamp de
  5min, comparação de credencial em tempo constante.

## Endpoints (mesmo contrato do relay Vercel)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/signal` | Armazena sinal e faz push para WebSockets inscritos no tópico |
| GET | `/api/signal?topic=&since=&to=` | Lista sinais (filtrado por cursor e destinatário) |
| DELETE | `/api/signal?topic=&beforeId=` | Remove sinais anteriores ao cursor |
| POST | `/api/peers` | Registro/heartbeat de presença assinado |
| GET | `/api/peers?wallet=` `/api/peers?peerId=` `/api/peers` | Consulta de presença |
| GET | `/api/status` | Saúde do relay (`services.durable_object`) |
| GET | `/ws?topics=a,b&wallet=0x…&key=` | WebSocket push por tópico |

Autenticação: `X-Rapport-Client-Key` para clientes não-browser (obrigatório
em todos os endpoints); browser é governado por CORS. Não utilizável por
humanos diretamente; nível de agente: cliente do dApp.

## Setup

```bash
npm install
npx wrangler login
npx wrangler secret put RELAY_CLIENT_KEYS   # mesmas chaves do relay Vercel
npx wrangler secret put BAN_DAO_ADDRESS   # opcional
npx wrangler secret put POLYGON_RPC_URL   # opcional
npm run deploy
```

Desenvolvimento local:

```bash
cp .dev.vars.example .dev.vars  # ou crie com RELAY_CLIENT_KEYS=...
npm run dev                     # http://localhost:8787 (Miniflare)
npm run typecheck
```

## Variáveis

| Nome | Tipo | Descrição |
|---|---|---|
| `RELAY_CLIENT_KEYS` | secret | Credenciais válidas do dApp (vírgula) |
| `BAN_DAO_ADDRESS` | secret | Endereço BanQuadraticDAO na Polygon |
| `POLYGON_RPC_URL` | secret | RPC Polygon (default `polygon-rpc.com`) |
| `RELAY_REQUIRE_SIGNATURE` | var | `false` só para dev local |
| `ALLOWED_ORIGINS` | var | Origins extras de CORS (vírgula) |
| `BANNED_WALLETS` | var | Overrides estáticos de ban (vírgula) |

## Coexistência com o relay Vercel

Dados frios (`/api/stats`, `/api/escrow-request`, `/api/tx-report`,
`/api/ban`, `/api/onramp-session`, `/api/version`) permanecem no relay
Vercel/Upstash — volume baixo. No dApp:
`EXPO_PUBLIC_SIGNALING_URL` → URL do Worker;
`EXPO_PUBLIC_ESCROW_RELAY_URL`/`EXPO_PUBLIC_ONRAMP_RELAY_URL` → Vercel.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-02 | 0.1.0 | Implementação inicial: REST compatível + WebSocket push, sem Upstash |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
