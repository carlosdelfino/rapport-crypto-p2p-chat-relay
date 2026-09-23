import { setCorsHeaders } from '../lib/cors.js';
import { createStore } from '../lib/store.js';
import type { RelayStats } from '../lib/store.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';

/**
 * GET /api/stats
 *
 * Retorna estatísticas agregadas do relay: total de carteiras registradas,
 * carteiras online, mensagens de chat transmitidas (acumulativo), chats ativos
 * e sinais de sistema atualmente armazenados.
 *
 * Também agrega a movimentação financeira registrada (pedidos de escrow por
 * ativo, com contagem e montante somado) e um grafo de interações entre
 * carteiras (data.walletGraph: nós anonimizados por hash e arestas com
 * contagem de mensagens de chat, transações on-chain por tipo e montantes
 * por ativo). As arestas on-chain são descobertas via explorers públicos:
 * Etherscan v2 (com ETHERSCAN_API_KEY) ou Blockscout para EVM, mempool.space
 * para Bitcoin, Horizon para Stellar e RPC público para Solana. Endereços de
 * carteira nunca são expostos na resposta.
 *
 * Mensagens de chat são envelopes do tipo 'data' em tópicos iniciados por
 * 'chat.v1.direct.' (par de endereços) ou '/chat/v1/group/' (grupo). Cada
 * tópico de chat distinto representa um chat.
 *
 * Não requer autenticação. Utilizável por humano e por agente.
 *
 * Resposta:
 *   200 — { code, message, data: RelayStats, next_step }
 *   503 — { code, message, details, next_step } quando Redis indisponível
 */
export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  setCorsHeaders(res);

  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  let stats: RelayStats;
  try {
    const store = createStore();
    stats = await store.getStats();
  } catch (err) {
    const msg = (err as Error).message;
    res.status(503).json({
      code: 503,
      message: 'Store indisponível',
      details: msg.includes('Redis') ? 'Redis não configurado' : 'Erro interno',
      next_step: 'Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN',
    });
    return;
  }

  res.status(200).json({
    code: 200,
    message: 'Estatísticas do relay',
    data: stats,
    next_step: 'Use os dados para exibir métricas públicas na página /stats',
  });
}
