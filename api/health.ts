import { setCorsHeaders } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { getStoreType } from '../lib/store.js';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  setCorsHeaders(res);
  const store = getStoreType();
  const status = store === 'redis' ? 'ok' : 'degraded';
  res.status(200).json({
    code: 200,
    message: `health ${status}`,
    data: { store },
    next_step:
      store === 'redis'
        ? 'Use /api/peers and /api/signal'
        : 'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN before using in production',
  });
}
