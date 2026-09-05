import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { createStore } from '../lib/store.js';
import { isSignatureRequired, isRecentTimestamp, verifyRequestSignature } from '../lib/auth.js';
import { getAddress } from 'viem';
import type { SignalEnvelope, SignalType, ApiResponse } from '../lib/types.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const MAX_PAYLOAD_LENGTH = 64 * 1024;
const store = createStore();

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (req.method === 'POST') {
    await postSignal(req, res);
    return;
  }

  if (req.method === 'GET') {
    await getSignals(req, res);
    return;
  }

  res.status(405).json({ code: 405, message: 'Method not allowed' });
}

async function postSignal(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = req.body as Partial<SignalEnvelope>;
  const topic = body.topic?.trim();
  const type = body.type as SignalType;
  const payload = body.payload;
  const from = body.from?.toLowerCase()?.trim();
  const to = body.to?.toLowerCase()?.trim();
  const timestamp = body.timestamp || 0;

  if (!topic || topic.length > 128) {
    res.status(400).json({ code: 400, message: 'Invalid or missing topic' });
    return;
  }

  if (!from || !ADDRESS_REGEX.test(from)) {
    res.status(400).json({ code: 400, message: 'Invalid sender wallet' });
    return;
  }

  if (to && !ADDRESS_REGEX.test(to)) {
    res.status(400).json({ code: 400, message: 'Invalid recipient wallet' });
    return;
  }

  if (!['offer', 'answer', 'ice'].includes(type)) {
    res.status(400).json({ code: 400, message: 'Invalid signal type' });
    return;
  }

  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_LENGTH) {
    res.status(400).json({ code: 400, message: 'Invalid or oversized payload' });
    return;
  }

  if (!isRecentTimestamp(timestamp)) {
    res.status(400).json({ code: 400, message: 'Timestamp outside accepted window' });
    return;
  }

  let normalizedFrom: string;
  try {
    normalizedFrom = getAddress(from);
  } catch {
    res.status(400).json({ code: 400, message: 'Invalid sender checksum' });
    return;
  }

  const messageToSign = JSON.stringify({ topic, type, payload, from: normalizedFrom, to, timestamp });

  if (isSignatureRequired() && !body.signature) {
    res.status(401).json({ code: 401, message: 'Signature required' });
    return;
  }

  if (body.signature) {
    const valid = await verifyRequestSignature(normalizedFrom, messageToSign, body.signature);
    if (!valid) {
      res.status(403).json({ code: 403, message: 'Invalid signature' });
      return;
    }
  }

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

  await store.addSignal(topic, envelope);

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
    res.status(400).json({ code: 400, message: 'Missing topic' });
    return;
  }

  let normalizedTo: string | undefined;
  if (to) {
    const cleaned = to.toLowerCase().trim();
    if (!ADDRESS_REGEX.test(cleaned)) {
      res.status(400).json({ code: 400, message: 'Invalid recipient wallet' });
      return;
    }
    try {
      normalizedTo = getAddress(cleaned);
    } catch {
      res.status(400).json({ code: 400, message: 'Invalid recipient checksum' });
      return;
    }
  }

  const messages = await store.getSignals(topic, { since, to: normalizedTo });

  const response: ApiResponse<SignalEnvelope[]> = {
    code: 200,
    message: 'Signals retrieved',
    data: messages,
    next_step: messages.length ? 'Process signals and re-poll for more' : 'Keep polling periodically',
  };
  res.status(200).json(response);
}
