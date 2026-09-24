import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import { createStore } from '../lib/store.js';
import { isRecentTimestamp } from '../lib/auth.js';
import type { TxReportRecord, ApiResponse } from '../lib/types.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOL_REGEX = /^[A-Z0-9][A-Z0-9._-]{0,11}$/;
const KIND_REGEX = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_AMOUNT = 1e15;
const store = createStore();

/**
 * POST /api/tx-report — o dApp reporta volume transacionado de forma
 * anônima: apenas rede, ativo, montante e tipo. Nenhum endereço de carteira,
 * txHash ou assinatura é aceito — os agregados alimentam /api/stats
 * (data.financial: volumeBySymbol, volumeByNetwork, countByKind).
 *
 * Não requer autenticação. Utilizável por agente (dApp), não por humano.
 *
 * Resposta:
 *   200 — { code, message, data: { reportId, accepted }, next_step }
 *   400 — { code, message } payload inválido
 *   405 — método não suportado
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ code: 405, message: 'Method not allowed' });
    return;
  }

  const body = req.body as Partial<TxReportRecord>;
  const reportId = String(body.reportId ?? '').trim();
  const chainId = Number(body.chainId);
  const symbol = String(body.symbol ?? '').trim().toUpperCase();
  const network = String(body.network ?? '').trim().slice(0, 80);
  const amountStr = String(body.amount ?? '').trim();
  const amount = Number(amountStr.replace(/,/g, ''));
  const kind = String(body.kind ?? 'payment').trim().toLowerCase();
  const timestamp = Number(body.timestamp) || 0;

  if (!UUID_REGEX.test(reportId)) {
    res.status(400).json({ code: 400, message: 'Missing or invalid reportId (uuid)' });
    return;
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    res.status(400).json({ code: 400, message: 'Missing or invalid chainId' });
    return;
  }
  if (!SYMBOL_REGEX.test(symbol)) {
    res.status(400).json({ code: 400, message: 'Missing or invalid symbol' });
    return;
  }
  if (!amountStr || amountStr.length > 64 || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    res.status(400).json({ code: 400, message: 'Missing or invalid amount' });
    return;
  }
  if (!KIND_REGEX.test(kind)) {
    res.status(400).json({ code: 400, message: 'Missing or invalid kind' });
    return;
  }
  if (!isRecentTimestamp(timestamp)) {
    res.status(400).json({ code: 400, message: 'Timestamp outside the accepted window' });
    return;
  }

  const record: TxReportRecord = {
    reportId,
    chainId,
    network,
    symbol,
    amount: amountStr,
    kind,
    timestamp,
    receivedAt: Date.now(),
  };

  const accepted = await store.addTxReport(record);

  const response: ApiResponse<{ reportId: string; accepted: boolean }> = {
    code: 200,
    message: accepted ? 'Transaction volume reported' : 'Duplicate report ignored',
    data: { reportId, accepted },
    next_step: 'Aggregated volume is available in GET /api/stats (data.financial)',
  };
  res.status(200).json(response);
}
