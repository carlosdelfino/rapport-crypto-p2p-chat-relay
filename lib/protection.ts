import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Redis } from '@upstash/redis';
import type { VercelRequest, VercelResponse } from './vercel.js';

export interface ProtectionState {
  recent: number[];
  blockedUntil: number;
  strikes: number;
  lastAbuse: number;
  lastEpisode: number;
  nextSend: number;
  httpStart: number;
  httpCount: number;
}

export interface ProtectionDecision {
  reason: 'allowed' | 'interval' | 'cooldown';
  retryAfterMs: number;
  cooldownUntil: number;
}

export function decideProtection(state: ProtectionState, now: number, signal: boolean, failure = false): ProtectionDecision {
  if (now - state.lastAbuse >= 86_400_000 && state.blockedUntil <= now) state.strikes = 0;
  if (now - state.httpStart >= 60_000) {
    state.httpStart = now;
    state.httpCount = 0;
  }
  state.httpCount = Math.min(601, state.httpCount + 1);
  const limit = failure ? 30 : 10;
  state.recent = state.recent.filter((time) => now - time < (failure ? 60_000 : 1000));
  if (signal || failure) state.recent = [...state.recent, now].slice(-(limit + 1));
  if ((state.recent.length > limit || state.httpCount > 600) && now - state.lastEpisode >= 1000) {
    state.strikes = Math.min(11, state.strikes + 1);
    state.lastAbuse = now;
    state.lastEpisode = now;
    state.blockedUntil = Math.max(state.blockedUntil, now + Math.min(30_000 * state.strikes ** 2, 3_600_000));
    state.recent = [];
    state.httpStart = now;
    state.httpCount = 0;
  }
  if (state.blockedUntil > now) {
    return { reason: 'cooldown', retryAfterMs: state.blockedUntil - now, cooldownUntil: state.blockedUntil };
  }
  return { reason: 'allowed', retryAfterMs: 0, cooldownUntil: 0 };
}

export function emptyProtectionState(): ProtectionState {
  return { recent: [], blockedUntil: 0, strikes: 0, lastAbuse: 0, lastEpisode: -1000, nextSend: 0, httpStart: 0, httpCount: 0 };
}

export const IP_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local s = raw and cjson.decode(raw) or {recent={}, blockedUntil=0, strikes=0, lastAbuse=0, lastEpisode=-1000, nextSend=0, httpStart=0, httpCount=0}
local now = tonumber(ARGV[1])
local transition=0
if now-s.lastAbuse >= 86400000 and s.blockedUntil <= now then s.strikes=0 end
if now-s.httpStart >= 60000 then s.httpStart=now s.httpCount=0 end
s.httpCount=math.min(601,s.httpCount+1)
local failure=ARGV[3]=='1'
local limit=failure and 30 or 10
local window=failure and 60000 or 1000
local recent={}
for _,t in ipairs(s.recent) do if now-t < window then table.insert(recent,t) end end
if ARGV[2]=='1' or failure then table.insert(recent,now) end
while #recent>limit+1 do table.remove(recent,1) end
s.recent=recent
if (#recent>limit or s.httpCount>600) and now-s.lastEpisode>=1000 then
 s.strikes=math.min(11,s.strikes+1) s.lastAbuse=now s.lastEpisode=now
 s.blockedUntil=math.max(s.blockedUntil,now+math.min(30000*s.strikes*s.strikes,3600000))
 s.recent={} s.httpStart=now s.httpCount=0 transition=s.strikes
end
redis.call('SET',KEYS[1],cjson.encode(s),'PX',90000000)
if s.blockedUntil>now then return {'cooldown',s.blockedUntil-now,s.blockedUntil,transition} end
return {'allowed',0,0,transition}
`;

export const CLIENT_SCRIPT = `
local now=tonumber(ARGV[1])
local nextSend=tonumber(redis.call('GET',KEYS[1]) or '0')
if nextSend>now then return {'interval',nextSend-now,0} end
redis.call('SET',KEYS[1],now+1000,'PX',2000)
return {'allowed',0,0}
`;

class ProtectionService {
  private readonly states = new Map<string, { state: ProtectionState; touched: number }>();
  private readonly clients = new Map<string, number>();

  constructor(private readonly redis?: Redis) {}

  async check(key: string, signal: boolean, now = Date.now(), failure = false): Promise<ProtectionDecision> {
    if (this.redis) {
      const result = await this.redis.eval<(string | number)[], [string, number, number, number]>(IP_SCRIPT, [`protect:ip:${key}`], [now, signal ? '1' : '0', failure ? '1' : '0']);
      if (result[3]) this.logTransition(key, Number(result[3]), Number(result[2]));
      return { reason: result[0] as ProtectionDecision['reason'], retryAfterMs: Number(result[1]), cooldownUntil: Number(result[2]) };
    }
    for (const [id, entry] of this.states) if (now - entry.touched > 90_000_000) this.states.delete(id);
    if (!this.states.has(key) && this.states.size >= 10_000) throw new Error('Protection capacity reached');
    const entry = this.states.get(key) ?? { state: emptyProtectionState(), touched: now };
    entry.touched = now;
    this.states.set(key, entry);
    const before = entry.state.blockedUntil;
    const decision = decideProtection(entry.state, now, signal, failure);
    if (entry.state.blockedUntil !== before) this.logTransition(key, entry.state.strikes, entry.state.blockedUntil);
    return decision;
  }

  private logTransition(key: string, strikes: number, until: number): void {
    console.warn(`[${new Date().toISOString()}] [protection:transition] warn cooldown - ${JSON.stringify({ source: key.slice(0, 16), strikes, cooldownUntil: until })}`);
  }

  async failures(key: string, record = false): Promise<ProtectionDecision> {
    if (record) return this.check(`fail:${key}`, false, Date.now(), true);
    const state = this.redis
      ? await this.redis.get<ProtectionState>(`protect:ip:fail:${key}`)
      : this.states.get(`fail:${key}`)?.state;
    const until = state?.blockedUntil ?? 0;
    return { reason: until > Date.now() ? 'cooldown' : 'allowed', retryAfterMs: Math.max(0, until - Date.now()), cooldownUntil: until };
  }

  async checkClient(key: string, now = Date.now()): Promise<ProtectionDecision> {
    if (this.redis) {
      const result = await this.redis.eval<(string | number)[], [string, number, number]>(CLIENT_SCRIPT, [`protect:client:${key}`], [now]);
      return { reason: result[0] as ProtectionDecision['reason'], retryAfterMs: Number(result[1]), cooldownUntil: 0 };
    }
    for (const [id, until] of this.clients) if (until <= now) this.clients.delete(id);
    const until = this.clients.get(key) ?? 0;
    if (until > now) return { reason: 'interval', retryAfterMs: until - now, cooldownUntil: 0 };
    if (this.clients.size >= 10_000) throw new Error('Protection capacity reached');
    this.clients.set(key, now + 1000);
    return { reason: 'allowed', retryAfterMs: 0, cooldownUntil: 0 };
  }
}

let service: ProtectionService | undefined;
export function createProtectionService(): ProtectionService {
  if (service) return service;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'development' && (!url || !token)) throw new Error('Protection backend unavailable');
  service = new ProtectionService(url && token ? new Redis({ url, token }) : undefined);
  return service;
}

export function clientIp(req: VercelRequest): string {
  const header = process.env.VERCEL ? req.headers['x-vercel-forwarded-for'] : undefined;
  const value = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  const address = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  if (!isIP(address)) throw new Error('Client address unavailable');
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reject(res: VercelResponse, decision: ProtectionDecision): boolean {
  if (decision.reason === 'allowed') return true;
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
  res.status(429).json({
    code: 429,
    message: 'Please wait before sending again. Your connection will resume automatically after cooldown.',
    details: { reason: decision.reason, retry_after_ms: decision.retryAfterMs, cooldown_until: decision.cooldownUntil },
    next_step: 'Wait for Retry-After before retrying. Do not send requests during cooldown.',
    nest_step: 'Wait for Retry-After before retrying.',
  });
  return false;
}

export async function protectRequest(req: VercelRequest, res: VercelResponse, signal = false): Promise<boolean> {
  try {
    const key = digest(clientIp(req));
    const service = createProtectionService();
    const decision = await service.check(key, signal);
    if (!reject(res, decision)) return false;
    return reject(res, await service.failures(key));
  } catch {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ code: 503, message: 'Relay temporarily unavailable.', details: { retry_after_ms: 5000 }, next_step: 'Wait five seconds before retrying.' });
    return false;
  }
}

export async function rejectInvalidSignal(req: VercelRequest, res: VercelResponse, code: number, body: { message: string; [key: string]: unknown }): Promise<void> {
  try {
    const decision = await createProtectionService().failures(digest(clientIp(req)), true);
    if (!reject(res, decision)) return;
  } catch {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ code: 503, message: 'Relay temporarily unavailable.', details: { retry_after_ms: 5000 }, next_step: 'Wait five seconds before retrying.' });
    return;
  }
  res.status(code).json({ code, message: body.message, details: {}, next_step: 'Correct the envelope and signature before retrying.' });
}

export async function protectSignalClient(req: VercelRequest, res: VercelResponse, verifiedWallet?: string): Promise<boolean> {
  try {
    const identity = verifiedWallet ? `wallet:${verifiedWallet.toLowerCase()}` : `ip:${clientIp(req)}`;
    return reject(res, await createProtectionService().checkClient(digest(identity)));
  } catch {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ code: 503, message: 'Relay temporarily unavailable.', details: { retry_after_ms: 5000 }, next_step: 'Wait five seconds before retrying.' });
    return false;
  }
}
