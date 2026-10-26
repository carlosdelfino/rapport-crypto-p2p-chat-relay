import { randomUUID } from 'node:crypto';
import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import { protectRequest } from '../lib/protection.js';
import { OnrampInputError, parseOnrampInput } from '../lib/onramp-validation.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';
import { createOnrampServerKit } from '@circle-fin/onramp-kit/server';

let server: ReturnType<typeof createOnrampServerKit> | undefined;
function createServer(): ReturnType<typeof createOnrampServerKit> {
  server ??= createOnrampServerKit({
    apiKey: process.env.CIRCLE_ONRAMP_API_KEY ?? '',
    referrerDomain: process.env.CIRCLE_ONRAMP_REFERRER_DOMAIN,
    widgetBaseUrl: process.env.CIRCLE_ONRAMP_WIDGET_BASE_URL,
  });
  return server;
}

type SessionServer = Pick<ReturnType<typeof createOnrampServerKit>, 'createSession'>;

export function createOnrampHandler(factory: () => SessionServer = createServer) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    setCorsHeaders(res, req);
    if (req.method === 'OPTIONS') {
      handleOptions(res);
      return;
    }
    if (!(await protectRequest(req, res))) return;
    if (req.method !== 'POST') {
      res.status(405).json({ code: 405, message: 'Method not allowed', details: {}, next_step: 'Send POST with appUserId and destinationAddress.' });
      return;
    }
    if (Number(req.headers['content-length']) > 8192) {
      res.status(413).json({ code: 413, message: 'Onramp request is too large', details: { max_body_bytes: 8192 }, next_step: 'Reduce the request size.' });
      return;
    }
    const requestId = randomUUID();
    try {
      const input = parseOnrampInput(req.body);
      const session = await factory().createSession(input);
      res.status(200).json({ code: 200, message: 'Onramp session created', data: session, next_step: 'Use the session to mount the Onramp widget.' });
    } catch (error) {
      const invalid = error instanceof OnrampInputError;
      const status = invalid ? 400 : 502;
      console.warn(`[${new Date().toISOString()}] [onramp:handler] warn request_rejected - ${JSON.stringify({ requestId, category: invalid ? 'input' : 'upstream' })}`);
      res.status(status).json({
        code: status,
        message: invalid ? error.message : 'Onramp session creation failed',
        details: { request_id: requestId },
        next_step: invalid ? 'Use valid strings and at most 16 entries per asset collection.' : 'Try again later or contact support with the request ID.',
      });
    }
  };
}

export default createOnrampHandler();
