import { Redis } from '@upstash/redis';
import type { SignalEnvelope, PeerRecord } from './types.js';

const PEER_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_S = 60 * 60;

interface Store {
  addSignal(topic: string, envelope: SignalEnvelope): Promise<void>;
  getSignals(topic: string, opts?: { since?: string; to?: string }): Promise<SignalEnvelope[]>;
  deleteSignalsBefore(topic: string, beforeId: string): Promise<number>;
  addPeer(peer: PeerRecord): Promise<void>;
  getPeer(wallet: string): Promise<PeerRecord | null>;
  getPeers(minLastSeen?: number): Promise<PeerRecord[]>;
  removePeer(wallet: string): Promise<void>;
  getStats(): Promise<RelayStats>;
}

class UpstashStore implements Store {
  private redis: Redis;

  constructor() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error('Missing Upstash Redis credentials. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    }
    const maskedUrl = url.replace(/\/\/[^@]+@/, '//***@');
    const maskedToken = token.slice(0, 4) + '***';
    console.log(`[relay:store] UpstashStore connecting to ${maskedUrl} token:${maskedToken}`);
    this.redis = new Redis({ url, token });
  }

  async addSignal(topic: string, envelope: SignalEnvelope): Promise<void> {
    const key = `signal:${topic}`;
    console.log(`[relay:store] addSignal key:${key} type:${envelope.type} id:${envelope.id} from:${envelope.from} to:${envelope.to ?? 'any'}`);
    const rpushResult = await this.redis.rpush(key, JSON.stringify(envelope));
    console.log(`[relay:store] addSignal rpush result:${rpushResult} key:${key}`);
    await this.redis.expire(key, SIGNAL_TTL_S);
    const verify = await this.redis.llen(key);
    console.log(`[relay:store] addSignal verify llen:${verify} key:${key}`);
  }

  async getSignals(topic: string, opts?: { since?: string; to?: string }): Promise<SignalEnvelope[]> {
    const key = `signal:${topic}`;
    const raw = await this.redis.lrange(key, 0, -1);
    console.log(`[relay:store] getSignals key:${key} rawLen:${Array.isArray(raw) ? raw.length : -1} since:${opts?.since ?? 'none'} to:${opts?.to ?? 'any'}`);
    if (!Array.isArray(raw)) return [];
    const parsed = raw
      .map((item) => {
        try {
          if (typeof item === 'string') {
            return JSON.parse(item) as SignalEnvelope;
          }
          return item as unknown as SignalEnvelope;
        } catch {
          return null;
        }
      })
      .filter((item): item is SignalEnvelope => item !== null);

    return parsed.filter((signal) => {
      if (opts?.since && signal.id <= opts.since) return false;
      if (opts?.to && signal.to && signal.to.toLowerCase() !== opts.to.toLowerCase()) return false;
      return true;
    });
  }

  async deleteSignalsBefore(topic: string, beforeId: string): Promise<number> {
    const key = `signal:${topic}`;
    const raw = await this.redis.lrange(key, 0, -1);
    if (!Array.isArray(raw) || raw.length === 0) return 0;

    let trimCount = 0;
    const remaining: string[] = [];
    for (const item of raw) {
      let envelope: SignalEnvelope | null = null;
      try {
        envelope = typeof item === 'string' ? JSON.parse(item) as SignalEnvelope : item as unknown as SignalEnvelope;
      } catch {
        // keep unparseable items
        remaining.push(typeof item === 'string' ? item : JSON.stringify(item));
        continue;
      }
      if (envelope && envelope.id <= beforeId) {
        trimCount++;
      } else if (envelope) {
        remaining.push(typeof item === 'string' ? item : JSON.stringify(envelope));
      }
    }

    if (trimCount > 0) {
      const pipeline = this.redis.multi();
      pipeline.del(key);
      if (remaining.length > 0) {
        pipeline.rpush(key, ...remaining);
        pipeline.expire(key, SIGNAL_TTL_S);
      }
      await pipeline.exec();
      console.log(`[relay:store] deleteSignalsBefore key:${key} trimmed:${trimCount} remaining:${remaining.length}`);
    }
    return trimCount;
  }

  async addPeer(peer: PeerRecord): Promise<void> {
    const record = { ...peer, lastSeen: Date.now() };
    await this.redis.hset('peers', { [peer.wallet]: JSON.stringify(record) });
    await this.redis.zadd('peers:online', { score: record.lastSeen, member: peer.wallet });
  }

  async getPeer(wallet: string): Promise<PeerRecord | null> {
    const raw = await this.redis.hget<string>('peers', wallet);
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as PeerRecord;
      return Date.now() - record.lastSeen <= PEER_TTL_MS ? record : null;
    } catch {
      return null;
    }
  }

  async getPeers(minLastSeen?: number): Promise<PeerRecord[]> {
    const threshold = minLastSeen ?? Date.now() - PEER_TTL_MS;
    const members = await this.redis.zrange<string[]>('peers:online', threshold, '+inf', { byScore: true });
    if (!members.length) return [];
    const raw = await this.redis.hmget<Record<string, string | null>>('peers', ...members);
    if (!raw) return [];
    const records = Object.values(raw)
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .map((item) => {
        try {
          return JSON.parse(item) as PeerRecord;
        } catch {
          return null;
        }
      })
      .filter((item): item is PeerRecord => item !== null);
    return records.filter((r) => Date.now() - r.lastSeen <= PEER_TTL_MS);
  }

  async removePeer(wallet: string): Promise<void> {
    await this.redis.hdel('peers', wallet);
    await this.redis.zrem('peers:online', wallet);
  }

  async getStats(): Promise<RelayStats> {
    const totalWallets = await this.redis.hlen('peers');
    const now = Date.now();
    const onlineThreshold = now - PEER_TTL_MS;
    const onlineWallets = await this.redis.zcount('peers:online', onlineThreshold, '+inf');

    let totalMessages = 0;
    let totalTopics = 0;
    try {
      const keys = await this.redis.keys('signal:*');
      totalTopics = keys.length;
      for (const key of keys) {
        const len = await this.redis.llen(key);
        totalMessages += len;
      }
    } catch {
      // keys command might be disabled in some Redis configs
    }

    return {
      totalWallets,
      onlineWallets,
      totalMessages,
      totalTopics,
      updatedAt: new Date().toISOString(),
    };
  }
}

class MemoryStore implements Store {
  private signals = new Map<string, SignalEnvelope[]>();
  private peers = new Map<string, PeerRecord>();

  async addSignal(topic: string, envelope: SignalEnvelope): Promise<void> {
    const list = this.signals.get(topic) ?? [];
    list.push(envelope);
    this.signals.set(topic, list);
  }

  async getSignals(topic: string, opts?: { since?: string; to?: string }): Promise<SignalEnvelope[]> {
    const list = this.signals.get(topic) ?? [];
    return list.filter((signal) => {
      if (opts?.since && signal.id <= opts.since) return false;
      if (opts?.to && signal.to && signal.to.toLowerCase() !== opts.to.toLowerCase()) return false;
      return true;
    });
  }

  async deleteSignalsBefore(topic: string, beforeId: string): Promise<number> {
    const list = this.signals.get(topic);
    if (!list || list.length === 0) return 0;
    const before = list.filter((s) => s.id <= beforeId).length;
    this.signals.set(topic, list.filter((s) => s.id > beforeId));
    return before;
  }

  async addPeer(peer: PeerRecord): Promise<void> {
    this.peers.set(peer.wallet, { ...peer, lastSeen: Date.now() });
  }

  async getPeer(wallet: string): Promise<PeerRecord | null> {
    const record = this.peers.get(wallet);
    if (!record) return null;
    return Date.now() - record.lastSeen <= PEER_TTL_MS ? record : null;
  }

  async getPeers(minLastSeen?: number): Promise<PeerRecord[]> {
    const threshold = minLastSeen ?? Date.now() - PEER_TTL_MS;
    return Array.from(this.peers.values()).filter((r) => r.lastSeen >= threshold);
  }

  async removePeer(wallet: string): Promise<void> {
    this.peers.delete(wallet);
  }

  async getStats(): Promise<RelayStats> {
    const now = Date.now();
    const onlineThreshold = now - PEER_TTL_MS;
    const onlineWallets = Array.from(this.peers.values()).filter(
      (r) => r.lastSeen >= onlineThreshold
    ).length;
    let totalMessages = 0;
    for (const list of this.signals.values()) {
      totalMessages += list.length;
    }
    return {
      totalWallets: this.peers.size,
      onlineWallets,
      totalMessages,
      totalTopics: this.signals.size,
      updatedAt: new Date().toISOString(),
    };
  }
}

export function getStoreType(): 'redis' | 'memory' {
  const hasRedis =
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  if (hasRedis) return 'redis';
  return 'memory';
}

export function createStore(): Store {
  const type = getStoreType();
  if (type === 'redis') {
    return new UpstashStore();
  }

  const isVercelCloud = process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'development';
  if (isVercelCloud) {
    throw new Error(
      'Redis is required for the Vercel relay. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.'
    );
  }

  console.warn('[relay:store] Redis not configured; using in-memory store (not shared across Vercel invocations).');
  return new MemoryStore();
}

export interface RelayStats {
  totalWallets: number;
  onlineWallets: number;
  totalMessages: number;
  totalTopics: number;
  updatedAt: string;
}

export type { Store };
