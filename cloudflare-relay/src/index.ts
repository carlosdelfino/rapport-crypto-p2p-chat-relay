import { clientKeyMatches } from './auth.js';
import type { Env } from './types.js';

const CLIENT_KEY_HEADER = 'x-rapport-client-key';

function extraOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

function allowedOrigin(request: Request, env: Env): string | undefined {
  const origin = request.headers.get('origin');
  if (!origin) return undefined;
  const extras = extraOrigins(env);
  if (extras.includes('*') || extras.includes(origin)) return origin;
  const host = request.headers.get('host');
  if (host) {
    try {
      if (new URL(origin).host === host) return origin;
    } catch {
      // malformed Origin header — not allowed
    }
  }
  return undefined;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, X-Peer-Wallet, X-Peer-Id, ${CLIENT_KEY_HEADER}`,
    'Access-Control-Expose-Headers': 'Retry-After',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) next.headers.set(key, value);
  return next;
}

function sameHostReferer(request: Request): boolean {
  const referer = request.headers.get('referer');
  const host = request.headers.get('host');
  if (!referer || !host) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

function unauthorized(request: Request, env: Env): Response {
  return withCors(new Response(JSON.stringify({
    code: 401,
    message: 'Client credential required',
    details: { header: 'X-Rapport-Client-Key' },
    next_step: 'Send the X-Rapport-Client-Key header issued for the official dApp, or access through the relay web page.',
  }), { status: 401, headers: { 'Content-Type': 'application/json' } }), request, env);
}

/**
 * Entry point: CORS + client-credential guard in the Worker, then all
 * /api/* traffic is forwarded to the single SignalingHub Durable Object
 * where rate limiting, banlist, signatures and storage live in memory.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    if (url.pathname === '/api/health') {
      return withCors(Response.json({ code: 200, message: 'ok', next_step: 'Use /api/status for service detail' }), request, env);
    }

    // Client guard: browsers are governed by CORS; non-browser clients
    // (the dApp) must present a valid X-Rapport-Client-Key.
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    const browserAllowed = !!origin || site === 'same-origin' || site === 'same-site' || site === 'none' || sameHostReferer(request);
    if (!browserAllowed) {
      // WebSocket handshakes cannot carry custom headers in several
      // runtimes — accept the credential via ?key= on /ws as well.
      const candidate = request.headers.get(CLIENT_KEY_HEADER)?.trim()
        ?? (url.pathname === '/ws' ? url.searchParams.get('key')?.trim() : undefined);
      const keys = env.RELAY_CLIENT_KEYS ?? '';
      if (!candidate || !(await clientKeyMatches(candidate, keys))) {
        return unauthorized(request, env);
      }
    }

    if (!url.pathname.startsWith('/api/') && url.pathname !== '/ws') {
      return withCors(Response.json({ code: 404, message: 'Not found', next_step: 'Use /api/signal, /api/peers, /api/status or /ws' }, { status: 404 }), request, env);
    }

    const hub = env.SIGNALING_HUB.get(env.SIGNALING_HUB.idFromName('hub'));
    const response = await hub.fetch(request);
    // Do not wrap WebSocket upgrades — the 101 must pass through untouched.
    if (response.status === 101 && response.webSocket) return response;
    return withCors(response, request, env);
  },
} satisfies ExportedHandler<Env>;

export { SignalingHub } from './hub.js';
