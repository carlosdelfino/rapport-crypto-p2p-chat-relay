export type RedisStatus = 'available' | 'quota_exceeded' | 'unavailable' | 'not_configured';

export interface RelayStatus {
  status: 'available' | 'degraded';
  checked_at: string;
  retry_after_ms: number;
  services: {
    redis: RedisStatus;
    signaling: 'available' | 'unavailable';
    presence: 'available' | 'unavailable';
    protection: 'available' | 'unavailable';
  };
}

async function probeRedis(): Promise<RedisStatus> {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 'not_configured';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING']),
      signal: controller.signal,
    });
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (!response.ok || body.error || body.result !== 'PONG') {
      throw new Error(typeof body.error === 'string' ? body.error : 'Redis unavailable');
    }
    return 'available';
  } finally {
    clearTimeout(timeout);
  }
}

export function createRelayStatusService(probe = probeRedis, now = Date.now) {
  let cached: RelayStatus | undefined;
  let expires = 0;
  let pending: Promise<RelayStatus> | undefined;
  return {
    async read(): Promise<RelayStatus> {
      if (cached && now() < expires) return cached;
      if (pending) return pending;
      pending = (async () => {
        let redis: RedisStatus;
        try {
          redis = await probe();
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          redis = /quota|(?:daily|monthly|request|command|usage|bandwidth).*limit|limit.*exceed/i.test(message)
            ? 'quota_exceeded' : 'unavailable';
        }
        const available = redis === 'available';
        const dependency = available ? 'available' : 'unavailable';
        const retry = redis === 'quota_exceeded' ? 300_000 : 60_000;
        const result: RelayStatus = {
          status: available ? 'available' : 'degraded',
          checked_at: new Date(now()).toISOString(),
          retry_after_ms: retry,
          services: { redis, signaling: dependency, presence: dependency, protection: dependency },
        };
        if (cached?.services.redis !== redis) {
          console.info(`[${new Date(now()).toISOString()}] [relay-status:read] info status transition - ${JSON.stringify({ redis, status: result.status })}`);
        }
        cached = result;
        expires = now() + retry;
        return result;
      })();
      try { return await pending; } finally { pending = undefined; }
    },
  };
}

export const relayStatusService = createRelayStatusService();
