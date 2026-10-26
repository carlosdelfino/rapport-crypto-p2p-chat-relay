import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import handler from '../api/signal.js';
import type { VercelRequest, VercelResponse } from './vercel.js';

function response() {
  const headers = new Map<string, unknown>();
  const result = { status: 0, body: {} as Record<string, any> };
  const res = {
    setHeader: (key: string, value: unknown) => headers.set(key, value),
    status: (status: number) => { result.status = status; return res; },
    json: (body: Record<string, any>) => { result.body = body; },
  } as unknown as VercelResponse;
  return { res, result, headers };
}

async function envelope() {
  const account = privateKeyToAccount(generatePrivateKey());
  const body = { topic: 'test-topic', type: 'data', payload: 'encrypted', from: account.address.toLowerCase(), timestamp: Date.now() };
  return { ...body, signature: await account.signMessage({ message: JSON.stringify(body) }) };
}

function request(body: unknown, ip: string): VercelRequest {
  return { method: 'POST', headers: {}, socket: { remoteAddress: ip }, body, query: {} } as unknown as VercelRequest;
}

test('RF-RELAY-09 real handler rejects rapid signals and IP flood with safe contract', async () => {
  const body = await envelope();
  const first = response();
  await handler(request(body, '192.0.2.11'), first.res);
  assert.equal(first.result.status, 200);
  for (let i = 1; i < 11; i++) {
    const next = response();
    await handler(request(body, '192.0.2.11'), next.res);
    assert.equal(next.result.status, 429);
    assert.equal(next.result.body.details.reason, i === 10 ? 'cooldown' : 'interval');
    assert.ok(next.headers.has('Retry-After'));
    assert.equal(typeof next.result.body.next_step, 'string');
    assert.doesNotMatch(JSON.stringify(next.result.body), /stack|UPSTASH|signature/);
  }
  const independent = response();
  await handler(request(await envelope(), '192.0.2.12'), independent.res);
  assert.equal(independent.result.status, 200);
});

test('RF-RELAY-09 malformed body counts toward flood without throwing', async () => {
  for (let i = 0; i < 11; i++) {
    const next = response();
    await handler(request(null, '192.0.2.13'), next.res);
    assert.equal(next.result.status, i === 10 ? 429 : 400);
  }
});
