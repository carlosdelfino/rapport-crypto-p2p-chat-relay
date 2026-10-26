import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, createProtectionService, decideProtection, emptyProtectionState } from './protection.js';
import type { VercelRequest } from './vercel.js';

test('RF-RELAY-01 interval is shared across topics and exact at 1000ms', async () => {
  const guard = createProtectionService();
  assert.equal((await guard.checkClient('alice', 1000)).reason, 'allowed');
  assert.equal((await guard.checkClient('alice', 1999)).retryAfterMs, 1);
  assert.equal((await guard.checkClient('alice', 2000)).reason, 'allowed');
});

test('RF-RELAY-02 eleventh attempt suspends in rolling second, not calendar second', () => {
  const state = emptyProtectionState();
  for (let i = 0; i < 10; i++) assert.equal(decideProtection(state, 999 + i, true).reason, 'allowed');
  const decision = decideProtection(state, 1010, true);
  assert.equal(decision.reason, 'cooldown');
  assert.equal(decision.retryAfterMs, 30_000);
});

test('RF-RELAY-03 quadratic escalation, isolated probes, ceiling and rehabilitation', () => {
  const state = emptyProtectionState();
  let now = 10_000;
  for (let episode = 1; episode <= 13; episode++) {
    for (let i = 0; i < 11; i++) decideProtection(state, now, true);
    assert.equal(state.blockedUntil - now, Math.min(30_000 * episode ** 2, 3_600_000));
    assert.equal(decideProtection(state, now + 1, true).cooldownUntil, state.blockedUntil);
    now += 1001;
  }
  now += 86_400_001;
  for (let i = 0; i < 11; i++) decideProtection(state, now, true);
  assert.equal(state.strikes, 1);
});

test('RF-RELAY-04 memory remains bounded during flood', () => {
  const state = emptyProtectionState();
  for (let i = 0; i < 50_000; i++) decideProtection(state, 10_000, true);
  assert.ok(state.recent.length <= 11);
});

test('RF-RELAY-05 untrusted forwarded headers cannot override socket address', () => {
  const req = { headers: { 'x-forwarded-for': '192.0.2.99' }, socket: { remoteAddress: '::ffff:192.0.2.1' } } as unknown as VercelRequest;
  assert.equal(clientIp(req), '192.0.2.1');
});
