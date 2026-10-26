import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/status.js';
import type { VercelRequest, VercelResponse } from './vercel.js';

function response() {
  return {
    code: 0, headers: {} as Record<string, string | number | readonly string[]>, body: undefined as any,
    setHeader(key: string, value: string | number | readonly string[]) { this.headers[key] = value; return this; },
    status(code: number) { this.code = code; return this; },
    writeHead(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    end() { return this; },
  };
}

test('RF-RELAY-12 status API reports missing Redis without network and preserves safe envelope', async () => {
  const res = response();
  await handler({ method: 'GET', headers: {} } as VercelRequest, res as unknown as VercelResponse);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.status, 'degraded');
  assert.equal(res.body.data.services.redis, 'not_configured');
  assert.ok(res.body.next_step);
  assert.ok(res.body.nest_step);
  assert.match(String(res.headers['Cache-Control']), /s-maxage=60/);
});

test('RF-RELAY-12 rejects write methods and handles preflight without dependency probes', async () => {
  const res = response();
  await handler({ method: 'POST', headers: {} } as VercelRequest, res as unknown as VercelResponse);
  assert.equal(res.code, 405);
  assert.ok(res.body.details);
  const options = response();
  await handler({ method: 'OPTIONS', headers: {} } as VercelRequest, options as unknown as VercelResponse);
  assert.equal(options.code, 204);
});
