import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayStatusService } from './relay-status.js';

test('RF-RELAY-12 REST probe sends only PING and classifies provider quota errors', async () => {
  const original = globalThis.fetch;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-placeholder';
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.body, '["PING"]');
      assert.ok(options?.signal);
      return new Response(JSON.stringify({ result: 'PONG' }));
    };
    assert.equal((await createRelayStatusService().read()).status, 'available');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'ERR max requests limit exceeded' }), { status: 400 });
    assert.equal((await createRelayStatusService().read()).services.redis, 'quota_exceeded');
    globalThis.fetch = async () => new Response('<html>bad gateway</html>', { status: 502 });
    assert.equal((await createRelayStatusService().read()).services.redis, 'unavailable');
  } finally {
    globalThis.fetch = original;
    if (url === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = url;
    if (token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = token;
  }
});

test('RF-RELAY-12 shares concurrent probes and caches success for 60 seconds', async () => {
  let calls = 0;
  let now = 0;
  const service = createRelayStatusService(async () => { calls++; return 'available'; }, () => now);
  const results = await Promise.all(Array.from({ length: 20 }, () => service.read()));
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'available');
  now = 59_999;
  await service.read();
  assert.equal(calls, 1);
  now = 60_000;
  await service.read();
  assert.equal(calls, 2);
});

test('RF-RELAY-12 caches quota failures, sanitizes errors and recovers', async () => {
  let now = 0;
  let failing = true;
  const service = createRelayStatusService(async () => {
    if (failing) throw new Error('ERR max daily request limit exceeded sensitive diagnostic');
    return 'available';
  }, () => now);
  const degraded = await service.read();
  assert.equal(degraded.services.redis, 'quota_exceeded');
  assert.equal(degraded.services.signaling, 'unavailable');
  assert.ok(!JSON.stringify(degraded).includes('sensitive'));
  failing = false;
  now = 299_999;
  assert.equal((await service.read()).status, 'degraded');
  now = 300_000;
  assert.equal((await service.read()).status, 'available');
});

test('RF-RELAY-12 distinguishes unconfigured storage from network failure', async () => {
  assert.equal((await createRelayStatusService(async () => 'not_configured').read()).services.redis, 'not_configured');
  assert.equal((await createRelayStatusService(async () => { throw new Error('network failure'); }).read()).services.redis, 'unavailable');
});
