/**
 * @file qr-claim-signal.test.ts
 * @description Garante que o relay aceita e entrega o envelope canônico que o
 *              backend do Agentic Space envia para o tópico `hub-support`:
 *              assinatura EIP-191 sobre
 *              JSON.stringify({topic,type,payload,from,to,timestamp}) com
 *              endereços normalizados em minúsculas.
 *
 *              Regressão: o backend assinava um JSON com ordem e casing
 *              diferentes, o que fazia o relay rejeitar os alertas com 403.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import handler from '../api/signal.js';
import type { VercelRequest, VercelResponse } from './vercel.js';

const SUPPORT_WALLET = '0x7010A4C4c189AB421028a622e2A2e623f432d18e';

function response() {
  const headers = new Map<string, unknown>();
  const result = { status: 0, body: {} as Record<string, any> };
  const res = {
    setHeader: (key: string, value: unknown) => headers.set(key, value),
    status: (status: number) => { result.status = status; return res; },
    json: (body: Record<string, any>) => { result.body = body; },
  } as unknown as VercelResponse;
  return { res, result };
}

function request(method: string, body: unknown, query: Record<string, string>, ip: string): VercelRequest {
  return { method, headers: {}, socket: { remoteAddress: ip }, body, query } as unknown as VercelRequest;
}

/** Replica o formato de assinatura do crypto-chat-relay-client.js do backend. */
async function backendSupportEnvelope() {
  const account = privateKeyToAccount(generatePrivateKey());
  const timestamp = Date.now();
  const payload = JSON.stringify({
    kind: 'QR_CLAIM_SUPPORT_ALERT',
    notificationId: 'test-notification',
    alertType: 'INSUFFICIENT_VAULT_BALANCE',
    details: { campaignId: 'c1' },
  });
  const message = JSON.stringify({
    topic: 'hub-support',
    type: 'data',
    payload,
    from: account.address.toLowerCase(),
    to: SUPPORT_WALLET.toLowerCase(),
    timestamp,
  });
  const signature = await account.signMessage({ message });
  return {
    topic: 'hub-support',
    from: account.address,
    to: SUPPORT_WALLET,
    type: 'data',
    timestamp,
    payload,
    signature,
  };
}

test('RF-RELAY-QR-01 relay accepts canonical hub-support alert signed by backend', async () => {
  const body = await backendSupportEnvelope();
  const posted = response();
  await handler(request('POST', body, {}, '192.0.2.50'), posted.res);
  assert.equal(posted.result.status, 200, JSON.stringify(posted.result.body));
  assert.equal(posted.result.body.data.topic, 'hub-support');
  assert.equal(posted.result.body.data.to, SUPPORT_WALLET);

  const fetched = response();
  await handler(
    request('GET', undefined, { topic: 'hub-support', to: SUPPORT_WALLET.toLowerCase() }, '192.0.2.51'),
    fetched.res,
  );
  assert.equal(fetched.result.status, 200);
  const alerts = fetched.result.body.data as Array<{ payload: string }>;
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].payload, /QR_CLAIM_SUPPORT_ALERT/);
});

test('RF-RELAY-QR-02 relay rejects hub-support alert signed over wrong field order', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const timestamp = Date.now();
  const payload = '{"kind":"QR_CLAIM_SUPPORT_ALERT"}';
  // Formato antigo (bug): chaves na ordem do objeto JS do backend.
  const wrongMessage = JSON.stringify({
    topic: 'hub-support', from: account.address, to: SUPPORT_WALLET,
    type: 'data', timestamp, payload,
  });
  const signature = await account.signMessage({ message: wrongMessage });
  const res = response();
  await handler(
    request('POST', {
      topic: 'hub-support', from: account.address, to: SUPPORT_WALLET,
      type: 'data', timestamp, payload, signature,
    }, {}, '192.0.2.52'),
    res.res,
  );
  assert.equal(res.result.status, 403);
});
