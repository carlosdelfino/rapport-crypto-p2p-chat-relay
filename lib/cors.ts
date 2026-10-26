import type { ServerResponse, IncomingMessage } from 'node:http';

const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Resolves the request Origin when it is allowed to consume the API.
 * Allowed: same host as the request (the relay's own web page) or an
 * entry in ALLOWED_ORIGINS. Anything else returns undefined and no
 * Access-Control-Allow-Origin header is emitted, so the browser blocks
 * the response.
 */
export function allowedOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (!origin) return undefined;
  if (EXTRA_ORIGINS.includes('*') || EXTRA_ORIGINS.includes(origin)) return origin;
  const host = req.headers.host;
  if (host) {
    try {
      if (new URL(origin).host === host) return origin;
    } catch {
      // malformed Origin header — not allowed
    }
  }
  return undefined;
}

export function setCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
  const allowed = req ? allowedOrigin(req) : undefined;
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Peer-Wallet, X-Peer-Id, X-Rapport-Client-Key');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export function handleOptions(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}
