import { createHash, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from './vercel.js';
import { allowedOrigin } from './cors.js';
import { createProtectionService } from './protection.js';
import { clientIp } from './protection.js';

export const CLIENT_KEY_HEADER = 'x-rapport-client-key';

let warnedMissingKeys = false;

function configuredKeys(): string[] {
  return (process.env.RELAY_CLIENT_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function keyMatches(candidate: string): boolean {
  const digest = createHash('sha256').update(candidate).digest();
  return configuredKeys().some((key) =>
    timingSafeEqual(digest, createHash('sha256').update(key).digest())
  );
}

function sameHostReferer(req: VercelRequest): boolean {
  const referer = req.headers.referer;
  const host = req.headers.host;
  if (!referer || !host) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

function failClosed(): boolean {
  return process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'development';
}

async function rejectUnauthorized(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const ip = clientIp(req);
    await createProtectionService().failures(createHash('sha256').update(ip).digest('hex'), true);
  } catch {
    // protection backend unavailable — still reject
  }
  res.status(401).json({
    code: 401,
    message: 'Client credential required',
    details: { header: 'X-Rapport-Client-Key' },
    next_step: 'Send the X-Rapport-Client-Key header issued for the official dApp, or access through the relay web page.',
  });
}

/**
 * Authorizes the calling client before any rate-limit or business logic.
 *
 * Browser clients are governed by CORS: requests carrying an Origin are
 * processed and the response is readable only when the origin is allowed
 * (same host or ALLOWED_ORIGINS). Browser-native signals (Sec-Fetch-Site,
 * same-host Referer) also pass, covering GETs that omit Origin.
 *
 * Non-browser clients — the dApp and any script — must present a valid
 * X-Rapport-Client-Key (env RELAY_CLIENT_KEYS, comma-separated). In
 * production, missing server configuration fails closed; in local
 * development it fails open with a one-time warning.
 */
export async function authorizeRelayClient(req: VercelRequest, res: VercelResponse): Promise<boolean> {
  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigin(req)) {
      console.warn(`[${new Date().toISOString()}] [client-guard:origin] warn disallowed origin - ${JSON.stringify({ origin: String(origin).slice(0, 64) })}`);
    }
    return true;
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return true;
  if (sameHostReferer(req)) return true;

  const header = req.headers[CLIENT_KEY_HEADER];
  const candidate = (Array.isArray(header) ? header[0] : header)?.trim();
  if (candidate && keyMatches(candidate)) return true;

  const keys = configuredKeys();
  if (keys.length === 0 && !failClosed()) {
    if (!warnedMissingKeys) {
      warnedMissingKeys = true;
      console.warn(`[${new Date().toISOString()}] [client-guard:config] warn RELAY_CLIENT_KEYS not set - non-browser clients are not authenticated in development`);
    }
    return true;
  }

  console.warn(`[${new Date().toISOString()}] [client-guard:reject] warn missing or invalid client key - ${JSON.stringify({ path: req.url?.split('?')[0] })}`);
  await rejectUnauthorized(req, res);
  return false;
}
