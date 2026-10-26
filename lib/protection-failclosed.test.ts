import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VercelRequest, VercelResponse } from './vercel.js';

test('RF-RELAY-04 cold starts without Redis return safe 503 instead of module failure', async () => {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
  const request = { method: 'POST', body: {}, query: {}, headers: { 'x-vercel-forwarded-for': '192.0.2.100', origin: 'https://relay.test', host: 'relay.test' }, socket: {} } as unknown as VercelRequest;
  for (const path of ['signal', 'peers', 'tx-report', 'escrow-request', 'onramp-session', 'health', 'stats', 'ban']) {
    const { default: handler } = await import(`../api/${path}.ts`);
    let code = 0;
    let response: unknown;
    const headers = new Map<string, unknown>();
    const res = {
      setHeader: (key: string, value: unknown) => headers.set(key, value),
      status: (status: number) => { code = status; return res; },
      json: (body: unknown) => { response = body; },
    } as unknown as VercelResponse;
    await handler(request, res);
    assert.equal(code, 503, path);
    assert.equal(headers.get('Retry-After'), '5');
    assert.doesNotMatch(JSON.stringify(response), /UPSTASH|token|stack|credentials/);
  }
});
