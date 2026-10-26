import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnrampInputError, parseOnrampInput } from './onramp-validation.js';

const base = { appUserId: 'user', destinationAddress: '0x0000000000000000000000000000000000000001' };

test('RF-RELAY-11 bounded onramp filters retain supported fields only', () => {
  const input = { ...base, assets: { tokens: [' USDC '], chains: ['Ethereum'], pairs: [{ token: 'USDC', chain: 'Base', ignored: true }] }, ignored: true };
  assert.deepEqual(parseOnrampInput(input), { ...base, assets: { tokens: ['USDC'], chains: ['Ethereum'], pairs: [{ token: 'USDC', chain: 'Base' }] } });
  assert.deepEqual(parseOnrampInput(base), base);
});

test('RF-RELAY-11 collections are rejected before per-element validation', () => {
  const excessive = new Array(100000);
  Object.defineProperty(excessive, '0', { get() { throw new Error('Must not traverse oversized collections'); } });
  for (const field of ['tokens', 'chains', 'pairs']) {
    assert.throws(() => parseOnrampInput({ ...base, assets: { [field]: excessive } }), OnrampInputError);
    assert.throws(() => parseOnrampInput({ ...base, assets: { [field]: new Array(17).fill('USDC') } }), OnrampInputError);
  }
  assert.equal(parseOnrampInput({ ...base, assets: { tokens: new Array(16).fill('USDC') } }).assets?.tokens?.length, 16);
});

test('RF-RELAY-11 rejects malformed bodies, scalar types, strings and pairs', () => {
  for (const value of [null, [], 'body', { ...base, appUserId: 42 }, { ...base, destinationAddress: {} }, { ...base, appUserId: 'x'.repeat(129) }, { ...base, assets: [] }, { ...base, assets: { tokens: [null] } }, { ...base, assets: { tokens: ['x'.repeat(65)] } }, { ...base, assets: { pairs: [{ token: 'USDC', chain: [] }] } }, { ...base, assets: { tokens: ['x\u0000'] } }]) {
    assert.throws(() => parseOnrampInput(value), OnrampInputError);
  }
});
