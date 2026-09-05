import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import { createStore } from '../lib/store.js';
import { isSignatureRequired, isRecentTimestamp, verifyRequestSignature } from '../lib/auth.js';
import { getAddress } from 'viem';
import type { PeerRecord, ApiResponse } from '../lib/types.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const store = createStore();

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (req.method === 'POST') {
    await registerPeer(req, res);
    return;
  }

  if (req.method === 'GET') {
    await getPeers(req, res);
    return;
  }

  res.status(405).json({ code: 405, message: 'Method not allowed' });
}

async function registerPeer(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = req.body as Partial<PeerRecord>;
  const wallet = body.wallet?.toLowerCase()?.trim();

  if (!wallet || !ADDRESS_REGEX.test(wallet)) {
    res.status(400).json({ code: 400, message: 'Invalid wallet address' });
    return;
  }

  let normalized: string;
  try {
    normalized = getAddress(wallet);
  } catch {
    res.status(400).json({ code: 400, message: 'Invalid wallet checksum' });
    return;
  }

  if (!body.peerId || !body.chainId || !isRecentTimestamp(body.timestamp || 0)) {
    res.status(400).json({ code: 400, message: 'Missing or invalid peerId, chainId or timestamp' });
    return;
  }

  const messageToSign = JSON.stringify({
    wallet: normalized,
    peerId: body.peerId,
    chainId: body.chainId,
    multiaddrs: body.multiaddrs,
    timestamp: body.timestamp,
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

  const peer: PeerRecord = {
    wallet: normalized,
    peerId: body.peerId,
    chainId: body.chainId,
    multiaddrs: body.multiaddrs?.slice(0, 8) ?? [],
    timestamp: body.timestamp,
    lastSeen: Date.now(),
    signature: body.signature,
  };

  await store.addPeer(peer);

  const response: ApiResponse<PeerRecord> = {
    code: 200,
    message: 'Peer registered',
    data: peer,
    next_step: 'Poll /api/peers or exchange signaling messages via /api/signal',
  };
  res.status(200).json(response);
}

async function getPeers(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { wallet, peerId } = req.query as { wallet?: string; peerId?: string };

  if (wallet) {
    const normalized = wallet.toLowerCase().trim();
    if (!ADDRESS_REGEX.test(normalized)) {
      res.status(400).json({ code: 400, message: 'Invalid wallet address' });
      return;
    }
    const record = await store.getPeer(getAddress(normalized));
    const response: ApiResponse<PeerRecord | null> = {
      code: 200,
      message: record ? 'Peer found' : 'Peer not found or offline',
      data: record,
      next_step: record ? 'Use peer data to dial or send signal' : 'Register and retry later',
    };
    res.status(200).json(response);
    return;
  }

  if (peerId) {
    const all = await store.getPeers();
    const record = all.find((p) => p.peerId === peerId);
    const response: ApiResponse<PeerRecord | null> = {
      code: 200,
      message: record ? 'Peer found' : 'Peer not found or offline',
      data: record,
      next_step: record ? 'Use peer data to dial or send signal' : 'Register and retry later',
    };
    res.status(200).json(response);
    return;
  }

  const peers = await store.getPeers();
  const response: ApiResponse<PeerRecord[]> = {
    code: 200,
    message: 'Online peers listed',
    data: peers,
    next_step: 'Use peer data to dial or send signal',
  };
  res.status(200).json(response);
}
