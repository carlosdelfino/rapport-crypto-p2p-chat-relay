import { authorizeRelayClient } from '../lib/client-guard.js';
import { protectRequest, protectSignalClient, rejectInvalidSignal } from '../lib/protection.js';
import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { createStore } from '../lib/store.js';
import { isSignatureRequired, isRecentTimestamp, verifyRequestSignature } from '../lib/auth.js';
import { isBannedWallet } from '../lib/banlist.js';
import { getAddress } from 'viem';
import type { SignalEnvelope, SignalType, ApiResponse } from '../lib/types.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const MAX_PAYLOAD_LENGTH = 64 * 1024;
let instance: ReturnType<typeof createStore> | undefined;
const store = () => (instance ??= createStore());

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (!(await authorizeRelayClient(req, res))) return;
  if (!(await protectRequest(req, res, req.method === 'POST'))) return;

  if (req.method === 'POST') {
    await postSignal(req, res);
    return;
  }

  if (req.method === 'GET') {
    await getSignals(req, res);
    return;
  }

  if (req.method === 'DELETE') {
    await deleteSignals(req, res);
    return;
  }

  res.status(405).json({ code: 405, message: 'Method not allowed' });
}

async function postSignal(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid signal envelope', details: {}, next_step: 'Send a JSON signal envelope.' });
    return;
  }
  const body = req.body as Partial<SignalEnvelope>;
  if (typeof body.topic !== 'string' || typeof body.from !== 'string' || (body.to !== undefined && typeof body.to !== 'string')) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid signal fields', details: {}, next_step: 'Check topic, from and to.' });
    return;
  }
  const topic = body.topic?.trim();
  const type = body.type as SignalType;
  const payload = body.payload;
  const from = body.from?.toLowerCase()?.trim();
  const to = body.to?.toLowerCase()?.trim();
  const timestamp = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? body.timestamp : 0;

  if (!topic || topic.length > 128) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid or missing topic' });
    return;
  }

  if (!from || !ADDRESS_REGEX.test(from)) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid sender wallet' });
    return;
  }

  if (to && !ADDRESS_REGEX.test(to)) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid recipient wallet' });
    return;
  }

  if (!['offer', 'answer', 'ice', 'chat_request', 'data'].includes(type)) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid signal type' });
    return;
  }

  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_LENGTH) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid or oversized payload' });
    return;
  }

  if (!isRecentTimestamp(timestamp)) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Timestamp outside accepted window' });
    return;
  }

  let normalizedFrom: string;
  try {
    normalizedFrom = getAddress(from);
  } catch {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid sender checksum' });
    return;
  }

  // Banlist: carteiras banidas (DAO de banimento ou override do suporte)
  // não podem enviar nem receber sinais pelo relay.
  if (await isBannedWallet(normalizedFrom)) {
    res.status(403).json({ code: 403, message: 'Sender wallet is banned from the network', details: {}, next_step: 'Review network access policy.' });
    return;
  }
  if (to && (await isBannedWallet(getAddress(to)))) {
    res.status(403).json({ code: 403, message: 'Recipient wallet is banned from the network', details: {}, next_step: 'Review network access policy.' });
    return;
  }

  const messageToSign = JSON.stringify({ topic, type, payload, from, to, timestamp });

  if (isSignatureRequired() && !body.signature) {
    await rejectInvalidSignal(req, res, 401, { message: 'Signature required' });
    return;
  }

  if (body.signature) {
    const valid = await verifyRequestSignature(normalizedFrom, messageToSign, body.signature);
    if (!valid) {
      await rejectInvalidSignal(req, res, 403, { message: 'Invalid signature' });
      return;
    }
  }

  if (!(await protectSignalClient(req, res, body.signature ? normalizedFrom : undefined))) return;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const envelope: SignalEnvelope = {
    id,
    topic,
    type,
    payload,
    from: normalizedFrom,
    to: to ? getAddress(to) : undefined,
    timestamp,
    signature: body.signature,
  };

  await store().addSignal(topic, envelope);

  console.log(`[relay:signal] POST stored - topic:${topic} type:${type} from:${normalizedFrom} to:${envelope.to ?? 'any'} id:${id}`);

  const response: ApiResponse<SignalEnvelope> = {
    code: 200,
    message: 'Signal stored',
    data: envelope,
    next_step: 'Recipient should poll GET /api/signal?topic=<topic>&since=<id>&to=<wallet>',
  };
  res.status(200).json(response);
}

async function getSignals(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { topic, since, to } = req.query as { topic?: string; since?: string; to?: string };

  if (!topic) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Missing topic' });
    return;
  }

  let normalizedTo: string | undefined;
  if (to) {
    const cleaned = to.toLowerCase().trim();
    if (!ADDRESS_REGEX.test(cleaned)) {
      await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid recipient wallet' });
      return;
    }
    try {
      normalizedTo = getAddress(cleaned);
    } catch {
      await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Invalid recipient checksum' });
      return;
    }
    if (await isBannedWallet(normalizedTo)) {
      res.status(403).json({ code: 403, message: 'Recipient wallet is banned from the network', details: {}, next_step: 'Review network access policy.' });
      return;
    }
  }

  const messages = await store().getSignals(topic, { since, to: normalizedTo });

  console.log(`[relay:signal] GET retrieved - topic:${topic} since:${since ?? 'none'} to:${normalizedTo ?? 'any'} found:${messages.length}`);

  const response: ApiResponse<SignalEnvelope[]> = {
    code: 200,
    message: 'Signals retrieved',
    data: messages,
    next_step: messages.length ? 'Process signals and re-poll for more' : 'Keep polling periodically',
  };
  res.status(200).json(response);
}

async function deleteSignals(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { topic, beforeId } = req.query as { topic?: string; beforeId?: string };

  if (!topic) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Missing topic' });
    return;
  }

  if (!beforeId) {
    await rejectInvalidSignal(req, res, 400, { code: 400, message: 'Missing beforeId' });
    return;
  }

  const trimmed = await store().deleteSignalsBefore(topic, beforeId);

  console.log(`[relay:signal] DELETE trimmed - topic:${topic} beforeId:${beforeId} trimmed:${trimmed}`);

  const response: ApiResponse<{ trimmed: number }> = {
    code: 200,
    message: 'Signals trimmed',
    data: { trimmed },
    next_step: 'Continue polling with the same since parameter',
  };
  res.status(200).json(response);
}
