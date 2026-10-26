import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import { authorizeRelayClient } from '../lib/client-guard.js';
import { protectRequest } from '../lib/protection.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { getStoreType } from '../lib/store.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }
  if (!(await authorizeRelayClient(req, res))) return;
  if (!(await protectRequest(req, res))) return;
  const store = getStoreType();
  res.status(200).json({
    code: 200,
    message: store === 'redis' ? 'health ok' : 'health degraded',
    data: { store },
    next_step: store === 'redis' ? 'Use /api/peers and /api/signal' : 'Configure persistent storage before using in production',
  });
}
