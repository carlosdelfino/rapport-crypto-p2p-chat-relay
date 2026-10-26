import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_SCRIPT, IP_SCRIPT, decideProtection, emptyProtectionState } from './protection.js';

const exec = promisify(execFile);

test('RF-RELAY-08 real Redis atomicity and parity with memory implementation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-protection-'));
  const socket = join(directory, 'redis.sock');
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no']);
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.stdout.on('data', (data: Buffer) => {
        if (data.toString().includes('ready to accept connections')) resolve();
      });
      server.on('exit', (code) => reject(new Error(`Test Redis exited: ${code}`)));
    });
    const evaluate = async (script: string, key: string, ...args: string[]): Promise<[string, number, number]> => {
      const { stdout } = await exec('redis-cli', ['-s', socket, '--json', 'EVAL', script, '1', key, ...args]);
      return JSON.parse(stdout).slice(0, 3);
    };
    const decisions = await Promise.all(Array.from({ length: 20 }, () => evaluate(CLIENT_SCRIPT, 'client', '100000')));
    assert.equal(decisions.filter(([reason]) => reason === 'allowed').length, 1);
    assert.equal(decisions.filter(([reason]) => reason === 'interval').length, 19);
    const requests = await Promise.all(Array.from({ length: 20 }, () => evaluate(IP_SCRIPT, 'ip', '100000', '1', '0')));
    assert.equal(requests.filter(([reason]) => reason === 'allowed').length, 10);
    assert.equal(requests.filter(([reason]) => reason === 'cooldown').length, 10);
    const state = emptyProtectionState();
    for (const now of [100000, ...Array(10).fill(100100), ...Array(11).fill(101101), ...Array(11).fill(86402000)]) {
      const expected = decideProtection(state, now, true);
      assert.deepEqual(await evaluate(IP_SCRIPT, 'parity', String(now), '1', '0'), [expected.reason, expected.retryAfterMs, expected.cooldownUntil]);
    }
    const failures = emptyProtectionState();
    for (let i = 0; i < 31; i++) {
      const now = 200000 + i * 1000;
      const expected = decideProtection(failures, now, false, true);
      assert.deepEqual(await evaluate(IP_SCRIPT, 'failure', String(now), '0', '1'), [expected.reason, expected.retryAfterMs, expected.cooldownUntil]);
    }
    assert.equal(failures.strikes, 1);
  } finally {
    server.kill('SIGTERM');
    await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
    await rm(directory, { recursive: true, force: true });
  }
});
