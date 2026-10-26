import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.js';

test('RF-RELAY-09 Redis construction logs no endpoint or credential fragment', () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = '<test-only-placeholder>';
  const messages: string[] = [];
  const original = console.log;
  console.log = (message: unknown) => messages.push(String(message));
  try {
    createStore();
  } finally {
    console.log = original;
  }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages.join(''), /redis\.invalid|test-only|token:/);
  assert.match(messages[0], /Redis backend initialized/);
});
