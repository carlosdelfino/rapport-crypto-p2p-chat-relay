import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnrampHandler } from '../api/onramp-session.js';
import type { VercelRequest, VercelResponse } from './vercel.js';

type Factory = NonNullable<Parameters<typeof createOnrampHandler>[0]>;
const base = { appUserId: 'user', destinationAddress: '0x0000000000000000000000000000000000000001' };

async function invoke(body: unknown, factory: Factory, length?: string) {
  const result = { status: 0, body: {} as Record<string, any> };
  const response = {
    setHeader: () => {},
    status: (status: number) => { result.status = status; return response; },
    json: (json: Record<string, any>) => { result.body = json; },
  } as unknown as VercelResponse;
  const request = { method: 'POST', body, headers: { 'content-length': length }, socket: { remoteAddress: '192.0.2.80' } } as unknown as VercelRequest;
  await createOnrampHandler(factory)(request, response);
  return result;
}

test('RF-RELAY-11 rejects oversized or malformed filters before constructing SDK', async () => {
  let calls = 0;
  const factory = (() => { calls++; throw new Error('SDK must not run'); }) as Factory;
  for (const body of [null, { ...base, appUserId: {} }, { ...base, assets: { tokens: new Array(100000).fill(null) } }]) {
    const result = await invoke(body, factory);
    assert.equal(result.status, 400);
    assert.equal(typeof result.body.next_step, 'string');
  }
  assert.equal((await invoke(base, factory, '8193')).status, 413);
  assert.equal(calls, 0);
});

test('RF-RELAY-11 forwards only sanitized bounded values and keeps safe errors', async () => {
  let forwarded: unknown;
  const factory = (() => ({ createSession: async (input: unknown) => { forwarded = input; return { id: 'test-session' }; } })) as unknown as Factory;
  const result = await invoke({ ...base, ignored: 'do-not-forward', assets: { tokens: ['USDC'] } }, factory);
  assert.equal(result.status, 200);
  assert.deepEqual(forwarded, { ...base, assets: { tokens: ['USDC'], chains: undefined, pairs: undefined } });
  const failure = (() => ({ createSession: async () => { throw new Error('Internal credential diagnostic'); } })) as unknown as Factory;
  const rejected = await invoke(base, failure);
  assert.equal(rejected.status, 502);
  assert.doesNotMatch(JSON.stringify(rejected.body), /credential|stack|appUserId|destinationAddress/);
});
