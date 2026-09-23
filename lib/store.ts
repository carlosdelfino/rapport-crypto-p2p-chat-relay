import { Redis } from '@upstash/redis';
import type { SignalEnvelope, PeerRecord, EscrowRequestRecord } from './types.js';

const PEER_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_S = 60 * 60;
const CHAT_MESSAGE_COUNTER_KEY = 'stats:chat_messages:total';
const CHAT_TOPIC_SET_KEY = 'stats:chat_topics';
const ESCROW_REQUESTS_KEY = 'escrow:requests';
const ESCROW_REQUESTS_TTL_S = 30 * 24 * 60 * 60;
const ESCROW_REQUESTS_MAX = 500;

function parseAmount(amount: string): number {
  const normalized = String(amount).replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

interface FinancialStats {
  totalTransactions: number;
  volumeBySymbol: Array<{ symbol: string; count: number; amount: number }>;
  totalAmount: number;
}

interface NetworkGraphNode {
  id: string;
  label: string;
  group: 'wallet' | 'chat' | 'financial' | 'aggregate';
  value: number;
}

interface NetworkGraphLink {
  source: string;
  target: string;
  value: number;
}

interface NetworkGraph {
  nodes: NetworkGraphNode[];
  links: NetworkGraphLink[];
}

function buildFinancialStats(requests: EscrowRequestRecord[]): FinancialStats {
  const bySymbol = new Map<string, { count: number; amount: number }>();
  let totalAmount = 0;
  for (const request of requests) {
    const symbol = request.symbol || 'UNKNOWN';
    const amount = parseAmount(request.amount);
    const current = bySymbol.get(symbol) ?? { count: 0, amount: 0 };
    current.count += 1;
    current.amount += amount;
    bySymbol.set(symbol, current);
    totalAmount += amount;
  }
  const volumeBySymbol = Array.from(bySymbol.entries())
    .map(([symbol, data]) => ({ symbol, count: data.count, amount: data.amount }))
    .sort((a, b) => b.amount - a.amount);
  return {
    totalTransactions: requests.length,
    volumeBySymbol,
    totalAmount,
  };
}

function buildNetworkGraph(
  totalWallets: number,
  onlineWallets: number,
  totalMessages: number,
  totalChats: number,
  financial: FinancialStats,
): NetworkGraph {
  const nodes: NetworkGraphNode[] = [
    { id: 'wallets', label: 'Carteiras', group: 'wallet', value: totalWallets },
    { id: 'online', label: 'Online', group: 'wallet', value: onlineWallets },
    { id: 'chats', label: 'Chats', group: 'chat', value: totalChats },
    { id: 'messages', label: 'Mensagens', group: 'chat', value: totalMessages },
    { id: 'financial', label: 'Mov. financeira', group: 'financial', value: financial.totalTransactions },
    { id: 'amount', label: 'Montante movimentado', group: 'financial', value: financial.totalAmount },
  ];
  const links: NetworkGraphLink[] = [
    { source: 'wallets', target: 'online', value: onlineWallets },
    { source: 'wallets', target: 'chats', value: totalChats },
    { source: 'wallets', target: 'messages', value: totalMessages },
    { source: 'wallets', target: 'financial', value: financial.totalTransactions },
    { source: 'financial', target: 'amount', value: financial.totalAmount },
  ];
  for (const entry of financial.volumeBySymbol) {
    const id = `symbol-${entry.symbol}`;
    nodes.push({ id, label: entry.symbol, group: 'financial', value: entry.count });
    links.push({ source: 'financial', target: id, value: entry.count });
    nodes.push({ id: `${id}-amount`, label: `${entry.symbol} volume`, group: 'financial', value: entry.amount });
    links.push({ source: id, target: `${id}-amount`, value: entry.amount });
  }
  return { nodes, links };
}

function isChatTopic(topic: string): boolean {
  return topic.startsWith('chat.v1.direct.') || topic.startsWith('/chat/v1/group/');
}

function isChatMessage(envelope: SignalEnvelope): boolean {
  return envelope.type === 'data' && isChatTopic(envelope.topic);
}

interface Store {
  addSignal(topic: string, envelope: SignalEnvelope): Promise<void>;
  getSignals(topic: string, opts?: { since?: string; to?: string }): Promise<SignalEnvelope[]>;
  deleteSignalsBefore(topic: string, beforeId: string): Promise<number>;
  addPeer(peer: PeerRecord): Promise<void>;
  getPeer(wallet: string): Promise<PeerRecord | null>;
  getPeers(minLastSeen?: number): Promise<PeerRecord[]>;
  removePeer(wallet: string): Promise<void>;
  getStats(): Promise<RelayStats>;
  addEscrowRequest(request: EscrowRequestRecord): Promise<void>;
  getEscrowRequests(chainId?: number): Promise<EscrowRequestRecord[]>;
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

    if (isChatMessage(envelope)) {
      await this.redis.hincrby(CHAT_MESSAGE_COUNTER_KEY, 'total', 1);
      await this.redis.sadd(CHAT_TOPIC_SET_KEY, topic);
      console.log(`[relay:store] addSignal chat message counted - topic:${topic}`);
    }
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
    try {
      const counter = await this.redis.hget<number>(CHAT_MESSAGE_COUNTER_KEY, 'total');
      totalMessages = typeof counter === 'number' ? counter : 0;
    } catch {
      totalMessages = 0;
    }

    let totalChats = 0;
    try {
      totalChats = await this.redis.scard(CHAT_TOPIC_SET_KEY);
    } catch {
      totalChats = 0;
    }

    let totalSystemSignals = 0;
    try {
      const keys = await this.redis.keys('signal:*');
      for (const key of keys) {
        const len = await this.redis.llen(key);
        totalSystemSignals += len;
      }
    } catch {
      // keys command might be disabled in some Redis configs
    }

    let escrowRequests: EscrowRequestRecord[] = [];
    try {
      escrowRequests = await this.getEscrowRequests();
    } catch {
      // ignore errors when collecting financial stats
    }
    const financial = buildFinancialStats(escrowRequests);
    const networkGraph = buildNetworkGraph(
      totalWallets,
      onlineWallets,
      totalMessages,
      totalChats,
      financial,
    );

    return {
      totalWallets,
      onlineWallets,
      totalMessages,
      totalChats,
      totalSystemSignals,
      financial,
      networkGraph,
      updatedAt: new Date().toISOString(),
    };
  }

  async addEscrowRequest(request: EscrowRequestRecord): Promise<void> {
    // Dedup por escrowId: um retry do app não cria registros duplicados.
    const existing = await this.getEscrowRequests();
    if (existing.some((r) => r.escrowId === request.escrowId)) {
      console.log(`[relay:store] addEscrowRequest dedup escrowId:${request.escrowId}`);
      return;
    }
    await this.redis.lpush(ESCROW_REQUESTS_KEY, JSON.stringify(request));
    await this.redis.ltrim(ESCROW_REQUESTS_KEY, 0, ESCROW_REQUESTS_MAX - 1);
    await this.redis.expire(ESCROW_REQUESTS_KEY, ESCROW_REQUESTS_TTL_S);
    console.log(`[relay:store] addEscrowRequest chainId:${request.chainId} escrowId:${request.escrowId}`);
  }

  async getEscrowRequests(chainId?: number): Promise<EscrowRequestRecord[]> {
    const raw = await this.redis.lrange(ESCROW_REQUESTS_KEY, 0, -1);
    if (!Array.isArray(raw)) return [];
    const parsed = raw
      .map((item) => {
        try {
          return typeof item === 'string' ? (JSON.parse(item) as EscrowRequestRecord) : (item as EscrowRequestRecord);
        } catch {
          return null;
        }
      })
      .filter((item): item is EscrowRequestRecord => item !== null);
    return chainId !== undefined ? parsed.filter((r) => r.chainId === chainId) : parsed;
  }
}

class MemoryStore implements Store {
  private signals = new Map<string, SignalEnvelope[]>();
  private peers = new Map<string, PeerRecord>();
  private chatMessagesTotal = 0;
  private chatTopics = new Set<string>();
  private escrowRequests: EscrowRequestRecord[] = [];

  async addSignal(topic: string, envelope: SignalEnvelope): Promise<void> {
    const list = this.signals.get(topic) ?? [];
    list.push(envelope);
    this.signals.set(topic, list);

    if (isChatMessage(envelope)) {
      this.chatMessagesTotal++;
      this.chatTopics.add(topic);
    }
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
    let totalSystemSignals = 0;
    for (const list of this.signals.values()) {
      totalSystemSignals += list.filter((s) => !isChatMessage(s)).length;
    }
    const financial = buildFinancialStats(this.escrowRequests);
    const networkGraph = buildNetworkGraph(
      this.peers.size,
      onlineWallets,
      this.chatMessagesTotal,
      this.chatTopics.size,
      financial,
    );
    return {
      totalWallets: this.peers.size,
      onlineWallets,
      totalMessages: this.chatMessagesTotal,
      totalChats: this.chatTopics.size,
      totalSystemSignals,
      financial,
      networkGraph,
      updatedAt: new Date().toISOString(),
    };
  }

  async addEscrowRequest(request: EscrowRequestRecord): Promise<void> {
    if (this.escrowRequests.some((r) => r.escrowId === request.escrowId)) return;
    this.escrowRequests.unshift(request);
    if (this.escrowRequests.length > ESCROW_REQUESTS_MAX) {
      this.escrowRequests.length = ESCROW_REQUESTS_MAX;
    }
  }

  async getEscrowRequests(chainId?: number): Promise<EscrowRequestRecord[]> {
    return chainId !== undefined
      ? this.escrowRequests.filter((r) => r.chainId === chainId)
      : [...this.escrowRequests];
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
  totalChats: number;
  totalSystemSignals: number;
  financial: FinancialStats;
  networkGraph: NetworkGraph;
  updatedAt: string;
}

export type { FinancialStats, NetworkGraph, NetworkGraphNode, NetworkGraphLink };

export type { Store };
