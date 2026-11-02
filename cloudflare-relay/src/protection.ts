/**
 * In-memory anti-abuse limiter living inside the Durable Object. A single
 * hub DO makes this state effectively global — no Redis needed. Mirrors
 * the semantics of the Vercel relay's decideProtection: 10 signals/s or
 * 600 req/min trigger an escalating cooldown capped at 1h; strikes decay
 * after 24h without abuse.
 */
export interface ProtectionDecision {
  reason: 'allowed' | 'interval' | 'cooldown';
  retryAfterMs: number;
  cooldownUntil: number;
}

interface IpState {
  recent: number[];
  blockedUntil: number;
  strikes: number;
  lastAbuse: number;
  lastEpisode: number;
  httpStart: number;
  httpCount: number;
}

export class ProtectionService {
  private readonly ips = new Map<string, IpState>();
  private readonly clients = new Map<string, number>();

  check(key: string, signal: boolean, now = Date.now(), failure = false): ProtectionDecision {
    let s = this.ips.get(key);
    if (!s) {
      if (this.ips.size >= 10_000) throw new Error('Protection capacity reached');
      s = { recent: [], blockedUntil: 0, strikes: 0, lastAbuse: 0, lastEpisode: -1000, httpStart: 0, httpCount: 0 };
      this.ips.set(key, s);
    }
    if (now - s.lastAbuse >= 86_400_000 && s.blockedUntil <= now) s.strikes = 0;
    if (now - s.httpStart >= 60_000) { s.httpStart = now; s.httpCount = 0; }
    s.httpCount = Math.min(601, s.httpCount + 1);
    const limit = failure ? 30 : 10;
    const window = failure ? 60_000 : 1000;
    s.recent = s.recent.filter((t) => now - t < window);
    if (signal || failure) s.recent = [...s.recent, now].slice(-(limit + 1));
    if ((s.recent.length > limit || s.httpCount > 600) && now - s.lastEpisode >= 1000) {
      s.strikes = Math.min(11, s.strikes + 1);
      s.lastAbuse = now;
      s.lastEpisode = now;
      s.blockedUntil = Math.max(s.blockedUntil, now + Math.min(30_000 * s.strikes ** 2, 3_600_000));
      s.recent = [];
      s.httpStart = now;
      s.httpCount = 0;
      console.warn(`[${new Date().toISOString()}] [protection:transition] warn cooldown - ${JSON.stringify({ source: key.slice(0, 16), strikes: s.strikes, cooldownUntil: s.blockedUntil })}`);
    }
    if (s.blockedUntil > now) {
      return { reason: 'cooldown', retryAfterMs: s.blockedUntil - now, cooldownUntil: s.blockedUntil };
    }
    return { reason: 'allowed', retryAfterMs: 0, cooldownUntil: 0 };
  }

  failures(key: string, record = false): ProtectionDecision {
    if (record) return this.check(`fail:${key}`, false, Date.now(), true);
    const until = this.ips.get(`fail:${key}`)?.blockedUntil ?? 0;
    return until > Date.now()
      ? { reason: 'cooldown', retryAfterMs: until - Date.now(), cooldownUntil: until }
      : { reason: 'allowed', retryAfterMs: 0, cooldownUntil: 0 };
  }

  /** Per-wallet send pacing: one forwarded signal per second. */
  checkClient(key: string, now = Date.now()): ProtectionDecision {
    const until = this.clients.get(key) ?? 0;
    if (until > now) return { reason: 'interval', retryAfterMs: until - now, cooldownUntil: 0 };
    if (this.clients.size >= 10_000) throw new Error('Protection capacity reached');
    this.clients.set(key, now + 1000);
    return { reason: 'allowed', retryAfterMs: 0, cooldownUntil: 0 };
  }
}
