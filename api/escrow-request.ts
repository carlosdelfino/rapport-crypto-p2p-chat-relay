import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import { createStore } from '../lib/store.js';
import { isSignatureRequired, isRecentTimestamp, verifyRequestSignature } from '../lib/auth.js';
import { getAddress } from 'viem';
import type { EscrowRequestRecord, ApiResponse } from '../lib/types.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const store = createStore();

/**
 * POST /api/escrow-request — o dApp registra um pedido de suporte de escrow
 * quando o usuário tenta usar a função numa rede sem EscrowVault deployado.
 * GET  /api/escrow-request?chainId=<id> — o gestor lista os pedidos pendentes.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (req.method === 'POST') {
    await createEscrowRequest(req, res);
    return;
  }

  if (req.method === 'GET') {
    await listEscrowRequests(req, res);
    return;
  }

  res.status(405).json({ code: 405, message: 'Method not allowed' });
}

async function createEscrowRequest(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = req.body as Partial<EscrowRequestRecord>;
  const wallet = body.requesterWallet?.toLowerCase()?.trim();

  if (!wallet || !ADDRESS_REGEX.test(wallet)) {
    res.status(400).json({ code: 400, message: 'Invalid requesterWallet address' });
    return;
  }

  let normalized: string;
  try {
    normalized = getAddress(wallet);
  } catch {
    res.status(400).json({ code: 400, message: 'Invalid requesterWallet checksum' });
    return;
  }

  const chainId = Number(body.chainId);
  const amount = String(body.amount ?? '').trim();
  const symbol = String(body.symbol ?? '').trim().toUpperCase();
  const networkName = String(body.networkName ?? '').trim();
  const escrowId = String(body.escrowId ?? '').trim();
  const timestamp = Number(body.timestamp) || 0;

  if (!UUID_REGEX.test(escrowId)) {
    res.status(400).json({ code: 400, message: 'Missing or invalid escrowId (uuid)' });
    return;
  }
  if (!Number.isInteger(chainId) || chainId <= 0 || !networkName || !amount || !symbol || !isRecentTimestamp(timestamp)) {
    res.status(400).json({ code: 400, message: 'Missing or invalid chainId, networkName, amount, symbol or timestamp' });
    return;
  }
  if (symbol.length > 12 || networkName.length > 80 || amount.length > 40) {
    res.status(400).json({ code: 400, message: 'Field exceeds maximum length' });
    return;
  }

  const messageToSign = JSON.stringify({
    requesterWallet: normalized,
    escrowId,
    chainId,
    networkName,
    amount,
    symbol,
    timestamp,
  });

  if (isSignatureRequired() && !body.signature) {
    res.status(401).json({ code: 401, message: 'Signature required' });
    return;
  }

  if (body.signature) {
    const valid = await verifyRequestSignature(normalized, messageToSign, body.signature);
    if (!valid) {
      res.status(403).json({ code: 403, message: 'Invalid signature' });
      return;
    }
  }

  const record: EscrowRequestRecord = {
    escrowId,
    requesterWallet: normalized,
    chainId,
    networkName,
    amount,
    symbol,
    timestamp,
    receivedAt: Date.now(),
    signature: body.signature,
  };

  await store.addEscrowRequest(record);

  const response: ApiResponse<EscrowRequestRecord> = {
    code: 200,
    message: 'Escrow network request registered',
    data: record,
    next_step: 'The app manager will be notified to deploy the escrow contract on this network',
  };
  res.status(200).json(response);
}

async function listEscrowRequests(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { chainId } = req.query as { chainId?: string };
  const filter = chainId !== undefined ? Number(chainId) : undefined;

  if (filter !== undefined && (!Number.isInteger(filter) || filter <= 0)) {
    res.status(400).json({ code: 400, message: 'Invalid chainId filter' });
    return;
  }

  const requests = await store.getEscrowRequests(filter);
  const response: ApiResponse<EscrowRequestRecord[]> = {
    code: 200,
    message: requests.length > 0 ? 'Escrow network requests listed' : 'No pending escrow requests',
    data: requests,
    next_step: requests.length > 0 ? 'Deploy EscrowVault on the requested networks' : 'Nothing to deploy',
  };
  res.status(200).json(response);
}
