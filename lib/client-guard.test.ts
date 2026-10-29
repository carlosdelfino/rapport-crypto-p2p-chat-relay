import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRelayClient } from './client-guard.js';
import { createProtectionService } from './protection.js';
import type { VercelRequest, VercelResponse } from './vercel.js';

function request(headers: Record<string, string>): VercelRequest {
  return { method: 'GET', headers, socket: { remoteAddress: '192.0.2.50' }, query: {} } as unknown as VercelRequest;
}

function response() {
  const result = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    setHeader: () => undefined,
    status: (code: number) => { result.status = code; return res; },
    json: (body: Record<string, unknown>) => { result.body = body; },
  } as unknown as VercelResponse;
  return { res, result };
}

beforeEach(() => {
  delete process.env.RELAY_CLIENT_KEYS;
});

test('RF-RELAY-13 browser request with allowed same-host origin passes', async () => {
  const { res, result } = response();
  const ok = await authorizeRelayClient(request({ origin: 'https://relay.test', host: 'relay.test' }), res);
  assert.equal(ok, true);
  assert.equal(result.status, 0);
});

test('RF-RELAY-13 browser request with foreign origin is governed by CORS only', async () => {
  const { res, result } = response();
  const ok = await authorizeRelayClient(request({ origin: 'https://evil.example', host: 'relay.test' }), res);
  assert.equal(ok, true);
  assert.equal(result.status, 0);
});

test('RF-RELAY-13 same-origin fetch metadata passes without Origin', async () => {
  for (const site of ['same-origin', 'same-site', 'none']) {
    const { res } = response();
    assert.equal(await authorizeRelayClient(request({ 'sec-fetch-site': site, host: 'relay.test' }), res), true, site);
  }
});

test('RF-RELAY-13 same-host referer passes for legacy browser GETs', async () => {
  const { res } = response();
  const ok = await authorizeRelayClient(request({ referer: 'https://relay.test/stats', host: 'relay.test' }), res);
  assert.equal(ok, true);
});

test('RF-RELAY-13 valid client key passes for non-browser clients', async () => {
  process.env.RELAY_CLIENT_KEYS = 'key-one,key-two';
  const { res } = response();
  const ok = await authorizeRelayClient(request({ 'x-rapport-client-key': 'key-two' }), res);
  assert.equal(ok, true);
});

test('RF-RELAY-13 invalid client key is rejected when keys are configured', async () => {
  process.env.RELAY_CLIENT_KEYS = 'key-one';
  const { res, result } = response();
  const ok = await authorizeRelayClient(request({ 'x-rapport-client-key': 'wrong' }), res);
  assert.equal(ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 401);
  assert.doesNotMatch(JSON.stringify(result.body), /key-one/);
});

test('RF-RELAY-13 Redis quota failures cannot reject a valid credential or authorize an invalid one', async (t) => {
  process.env.RELAY_CLIENT_KEYS = 'key-one,key-two';
  const failures = t.mock.method(createProtectionService(), 'failures', async () => { throw new Error('simulated monthly command quota exceeded'); });
  const valid = response();
  assert.equal(await authorizeRelayClient(request({ 'x-rapport-client-key': 'key-two' }), valid.res), true);
  assert.equal(valid.result.status, 0);
  assert.equal(failures.mock.callCount(), 0);
  const invalid = response();
  assert.equal(await authorizeRelayClient(request({ 'x-rapport-client-key': 'incorrect' }), invalid.res), false);
  assert.equal(invalid.result.status, 401);
  assert.equal(failures.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(invalid.result.body), /quota|monthly|key-one|key-two|stack/);
});

test('RF-RELAY-13 missing key is rejected when keys are configured', async () => {
  process.env.RELAY_CLIENT_KEYS = 'key-one';
  const { res, result } = response();
  const ok = await authorizeRelayClient(request({}), res);
  assert.equal(ok, false);
  assert.equal(result.status, 401);
});

test('RF-RELAY-13 missing server configuration fails open in development', async () => {
  const { res } = response();
  assert.equal(await authorizeRelayClient(request({}), res), true);
});

test('RF-RELAY-13 missing server configuration fails closed in production', async () => {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  try {
    const { res, result } = response();
    const ok = await authorizeRelayClient(request({ 'x-vercel-forwarded-for': '192.0.2.51' }), res);
    assert.equal(ok, false);
    assert.equal(result.status, 401);
  } finally {
    delete process.env.VERCEL;
    process.env.VERCEL_ENV = 'development';
  }
});
