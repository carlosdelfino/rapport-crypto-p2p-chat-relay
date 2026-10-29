import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRelayClient } from './client-guard.js';
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

test('RF-RELAY-13 native credential matching is independent of missing Redis in production', async (t) => {
  const names = ['RELAY_CLIENT_KEYS', 'VERCEL', 'VERCEL_ENV', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const previous = names.map((name) => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.RELAY_CLIENT_KEYS = 'test-client-one, test-client-two';
  const { default: handler } = await import('../api/peers.js');
  for (const [credential, expected] of [['test-client-two', 503], ['incorrect-test-client', 401], ['', 401]] as const) {
    const req = {
      method: 'GET', url: '/api/peers', query: {},
      headers: { 'x-rapport-client-key': credential, 'x-vercel-forwarded-for': '192.0.2.101' },
      socket: {},
    } as unknown as VercelRequest;
    let status = 0;
    let body: Record<string, any> = {};
    const res = {
      setHeader: () => undefined,
      status: (code: number) => { status = code; return res; },
      json: (value: Record<string, any>) => { body = value; },
    } as unknown as VercelResponse;
    const authorized = await authorizeRelayClient(req, res);
    assert.equal(authorized, expected === 503);
    if (authorized) assert.equal(status, 0);
    await handler(req, res);
    assert.equal(status, expected);
    assert.equal(body.code, expected);
    if (authorized) assert.equal(body.details.reason, 'protection_unavailable');
    assert.doesNotMatch(JSON.stringify(body), /test-client|UPSTASH|stack|token/);
  }
});
