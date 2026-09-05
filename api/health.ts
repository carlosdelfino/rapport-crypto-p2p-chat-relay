import { setCorsHeaders } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  setCorsHeaders(res);
  res.status(200).json({ code: 200, message: 'ok', next_step: 'Use /api/peers and /api/signal' });
}
