import type { ServerResponse, IncomingMessage } from 'node:http';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((o) => o.trim());

export function setCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
  const origin = req?.headers.origin || '*';
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Peer-Wallet, X-Peer-Id');
}

export function handleOptions(res: ServerResponse): void {
  setCorsHeaders(res);
  res.writeHead(204);
  res.end();
}
