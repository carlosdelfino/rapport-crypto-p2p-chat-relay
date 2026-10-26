import { setCorsHeaders, handleOptions } from '../lib/cors.js';
import { authorizeRelayClient } from '../lib/client-guard.js';
import { relayStatusService } from '../lib/relay-status.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') { handleOptions(res); return; }
  if (!(await authorizeRelayClient(req, res))) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ code: 405, message: 'Method not allowed', details: {}, next_step: 'Use GET /api/status', nest_step: 'Use GET /api/status' });
    return;
  }
  const data = await relayStatusService.read();
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
  res.status(200).json({
    code: 200,
    message: data.status === 'available' ? 'Relay available' : 'Relay services degraded',
    data,
    next_step: 'Wait retry_after_ms before checking again; service states describe Redis dependency availability, not end-to-end delivery.',
    nest_step: 'Wait retry_after_ms before checking again.',
  });
}
