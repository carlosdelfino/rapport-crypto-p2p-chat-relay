import { protectRequest } from '../lib/protection.js';
import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { isRecentTimestamp, verifyRequestSignature } from '../lib/auth.js';
import { getAddress } from 'viem';
import {
  banAdminWallet,
  banDaoAddress,
  getOpenBanProposals,
  isBanFeatureEnabled,
  isBannedWallet,
  refreshBanFlags,
  setBanOverride,
} from '../lib/banlist.js';
import type { ApiResponse, BanProposalRecord } from '../lib/types.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

interface BanListData {
  enabled: boolean;
  daoAddress: string | null;
  proposals: BanProposalRecord[];
}

interface BanActionBody {
  action?: string;
  target?: string;
  banned?: boolean;
  targets?: string[];
  timestamp?: number;
  signature?: string;
}

/**
 * GET /api/ban — lista votações de banimento abertas na BanQuadraticDAO
 * (Polygon). ?wallet=<addr> retorna o status de banimento da carteira.
 * POST /api/ban — ações assinadas (EIP-191) pela carteira de suporte:
 *   { action: 'refresh', targets?: string[] }  → reconsulta flags on-chain
 *   { action: 'override', target, banned }     → ban/unban manual no relay
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (!(await protectRequest(req, res))) return;

  if (req.method === 'GET') {
    await getBan(req, res);
    return;
  }

  if (req.method === 'POST') {
    await postBan(req, res);
    return;
  }

  res.status(405).json({ code: 405, message: 'Method not allowed' });
}

async function getBan(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { wallet } = req.query as { wallet?: string };

  if (wallet) {
    const cleaned = wallet.toLowerCase().trim();
    if (!ADDRESS_REGEX.test(cleaned)) {
      res.status(400).json({ code: 400, message: 'Invalid wallet address' });
      return;
    }
    const normalized = getAddress(cleaned as `0x${string}`);
    const banned = await isBannedWallet(normalized);
    const response: ApiResponse<{ wallet: string; banned: boolean }> = {
      code: 200,
      message: banned ? 'Wallet is banned' : 'Wallet is not banned',
      data: { wallet: normalized, banned },
      next_step: banned
        ? 'A carteira está banida: o app e o relay bloqueiam suas mensagens.'
        : 'Use rapportchat://chat/<carteira> para abrir o chat no app.',
    };
    res.status(200).json(response);
    return;
  }

  const proposals = await getOpenBanProposals();
  const data: BanListData = {
    enabled: isBanFeatureEnabled(),
    daoAddress: banDaoAddress(),
    proposals,
  };

  console.log(`[relay:ban] GET proposals:${proposals.length} enabled:${data.enabled}`);

  const response: ApiResponse<BanListData> = {
    code: 200,
    message: 'Ban votes retrieved',
    data,
    next_step:
      'Para votar, abra rapportchat://chat/<carteira-alvo> no app e envie /ban. É necessário ter CAS em carteira.',
  };
  res.status(200).json(response);
}

async function postBan(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = req.body as BanActionBody;
  const action = body.action?.trim();
  const timestamp = body.timestamp || 0;

  if (!action || !['refresh', 'override'].includes(action)) {
    res.status(400).json({ code: 400, message: 'Invalid action' });
    return;
  }

  if (!isRecentTimestamp(timestamp)) {
    res.status(400).json({ code: 400, message: 'Timestamp outside accepted window' });
    return;
  }

  let normalizedTarget: string | undefined;
  if (body.target) {
    const cleaned = body.target.toLowerCase().trim();
    if (!ADDRESS_REGEX.test(cleaned)) {
      res.status(400).json({ code: 400, message: 'Invalid target wallet' });
      return;
    }
    try {
      normalizedTarget = getAddress(cleaned as `0x${string}`);
    } catch {
      res.status(400).json({ code: 400, message: 'Invalid target checksum' });
      return;
    }
  }

  if (action === 'override' && !normalizedTarget) {
    res.status(400).json({ code: 400, message: 'Missing target wallet' });
    return;
  }

  const admin = banAdminWallet();
  const messageToSign = JSON.stringify({
    action,
    target: normalizedTarget ?? null,
    banned: action === 'override' ? Boolean(body.banned) : null,
    targets: body.targets ?? null,
    timestamp,
  });

  if (!body.signature || !(await verifyRequestSignature(admin, messageToSign, body.signature))) {
    res.status(403).json({ code: 403, message: 'Invalid admin signature' });
    return;
  }

  if (action === 'refresh') {
    const refreshed = await refreshBanFlags(body.targets ?? (normalizedTarget ? [normalizedTarget] : []));
    const response: ApiResponse<{ refreshed: number }> = {
      code: 200,
      message: 'Ban flags refreshed',
      data: { refreshed },
      next_step: 'GET /api/ban para ver as votações abertas atualizadas.',
    };
    res.status(200).json(response);
    return;
  }

  await setBanOverride(normalizedTarget!, Boolean(body.banned));
  const response: ApiResponse<{ wallet: string; banned: boolean }> = {
    code: 200,
    message: 'Ban override applied',
    data: { wallet: normalizedTarget!, banned: Boolean(body.banned) },
    next_step: 'O relay passa a bloquear (ou liberar) a carteira imediatamente.',
  };
  res.status(200).json(response);
}
