for (const key of [
  'VERCEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'BAN_DAO_ADDRESS',
  'CIRCLE_ONRAMP_API_KEY',
]) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.VERCEL_ENV = 'development';
globalThis.fetch = async () => { throw new Error('External network is disabled in relay tests.'); };
