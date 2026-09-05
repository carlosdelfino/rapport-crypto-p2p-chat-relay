import { setCorsHeaders } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { getStoreType, createStore } from '../lib/store.js';

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res);
  const store = getStoreType();
  const status = store === 'redis' ? 'ok' : 'degraded';

  let redisTest: Record<string, unknown> = {};
  if (store === 'redis') {
    try {
      const s = createStore();
      const testKey = 'health-test';
      const testVal = `test-${Date.now()}`;
      await s.addSignal(testKey, {
        id: testVal,
        topic: testKey,
        type: 'offer',
        payload: 'test',
        from: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        timestamp: Date.now(),
      });
      const retrieved = await s.getSignals(testKey);
      redisTest = {
        write: 'ok',
        readCount: retrieved.length,
        readId: retrieved[0]?.id,
      };
    } catch (error: any) {
      redisTest = { write: 'failed', error: error?.message ?? 'unknown' };
    }
  }

  res.status(200).json({
    code: 200,
    message: `health ${status}`,
    data: { store, redisTest },
    next_step:
      store === 'redis'
        ? 'Use /api/peers and /api/signal'
        : 'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN before using in production',
  });
}
