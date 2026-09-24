import { Redis } from '@upstash/redis';
import type { SignalEnvelope, PeerRecord, EscrowRequestRecord, TxReportRecord } from './types.js';

const PEER_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_S = 60 * 60;
const CHAT_MESSAGE_COUNTER_KEY = 'stats:chat_messages:total';
const CHAT_TOPIC_SET_KEY = 'stats:chat_topics';
const ESCROW_REQUESTS_KEY = 'escrow:requests';
const ESCROW_REQUESTS_TTL_S = 30 * 24 * 60 * 60;
const ESCROW_REQUESTS_MAX = 500;
const TX_TOTAL_KEY = 'stats:tx:total';
const TX_SYMBOL_AMOUNT_KEY = 'stats:tx:vol:symbol';
const TX_SYMBOL_COUNT_KEY = 'stats:tx:cnt:symbol';
const TX_NETSYM_AMOUNT_KEY = 'stats:tx:vol:netsym';
const TX_NETSYM_COUNT_KEY = 'stats:tx:cnt:netsym';
const TX_NETWORK_NAME_KEY = 'stats:tx:net:name';
const TX_KIND_COUNT_KEY = 'stats:tx:cnt:kind';
const TX_DEDUP_PREFIX = 'stats:tx:seen:';
const TX_DEDUP_TTL_S = 90 * 24 * 60 * 60;

function parseAmount(amount: string): number {
  const normalized = String(amount).replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export interface SymbolVolume {
  symbol: string;
  count: number;
  amount: number;
}

export interface NetworkVolume {
  chainId: number;
  network: string;
  count: number;
  symbols: SymbolVolume[];
}

interface FinancialStats {
  totalTransactions: number;
  volumeBySymbol: SymbolVolume[];
  volumeByNetwork: NetworkVolume[];
  countByKind: Array<{ kind: string; count: number }>;
}

interface EscrowDemandStats {
  totalRequests: number;
  bySymbol: SymbolVolume[];
  byNetwork: Array<{ chainId: number; network: string; count: number }>;
}

interface TxAggregates {
  total: number;
  symbolCount: Map<string, number>;
  symbolAmount: Map<string, number>;
  netSymCount: Map<string, number>;
  netSymAmount: Map<string, number>;
  netNames: Map<string, string>;
  kindCount: Map<string, number>;
}

function isChatTopic(topic: string): boolean {
  return topic.startsWith('chat.v1.direct.') || topic.startsWith('/chat/v1/group/');
}

function isChatMessage(envelope: SignalEnvelope): boolean {
  return envelope.type === 'data' && isChatTopic(envelope.topic);
}

function recordToMap(raw: Record<string, string | number> | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!raw) return map;
  for (const [field, value] of Object.entries(raw)) {
    const n = Number(value);
    if (Number.isFinite(n)) map.set(field, n);
  }
  return map;
}

function recordToStringMap(raw: Record<string, string> | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) map.set(field, value);
  }
  return map;
}

function sortedSymbolVolume(counts: Map<string, number>, amounts: Map<string, number>): SymbolVolume[] {
  const entries: SymbolVolume[] = [];
  for (const [symbol, count] of counts) {
    entries.push({ symbol, count, amount: amounts.get(symbol) ?? 0 });
  }
  return entries.sort((a, b) => b.amount - a.amount || b.count - a.count);
}

function buildFinancialStats(agg: TxAggregates): FinancialStats {
  const volumeBySymbol = sortedSymbolVolume(agg.symbolCount, agg.symbolAmount);

  const networks = new Map<number, NetworkVolume>();
  for (const [field, count] of agg.netSymCount) {
    const idx = field.indexOf(':');
    if (idx <= 0) continue;
    const chainId = Number(field.slice(0, idx));
    const symbol = field.slice(idx + 1);
    if (!Number.isInteger(chainId) || !symbol) continue;
    let net = networks.get(chainId);
    if (!net) {
      net = {
        chainId,
        network: agg.netNames.get(String(chainId)) ?? `chainId ${chainId}`,
        count: 0,
        symbols: [],
      };
      networks.set(chainId, net);
    }
    net.count += count;
    net.symbols.push({ symbol, count, amount: agg.netSymAmount.get(field) ?? 0 });
  }
  const volumeByNetwork = [...networks.values()]
    .map((net) => ({ ...net, symbols: net.symbols.sort((a, b) => b.amount - a.amount || b.count - a.count) }))
    .sort((a, b) => b.count - a.count);

  const countByKind = [...agg.kindCount.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalTransactions: agg.total,
    volumeBySymbol,
    volumeByNetwork,
    countByKind,
  };
}

function buildEscrowDemand(requests: EscrowRequestRecord[]): EscrowDemandStats {
  const bySymbol = new Map<string, { count: number; amount: number }>();
  const byNetwork = new Map<number, { network: string; count: number }>();
  for (const request of requests) {
    const symbol = request.symbol || 'UNKNOWN';
    const current = bySymbol.get(symbol) ?? { count: 0, amount: 0 };
    current.count += 1;
    current.amount += parseAmount(request.amount);
    bySymbol.set(symbol, current);

    const net = byNetwork.get(request.chainId) ?? {
      network: request.networkName || `chainId ${request.chainId}`,
      count: 0,
    };
    net.count += 1;
    if (request.networkName) net.network = request.networkName;
    byNetwork.set(request.chainId, net);
  }
  return {
    totalRequests: requests.length,
    bySymbol: [...bySymbol.entries()]
      .map(([symbol, data]) => ({ symbol, count: data.count, amount: data.amount }))
      .sort((a, b) => b.amount - a.amount || b.count - a.count),
    byNetwork: [...byNetwork.entries()]
      .map(([chainId, data]) => ({ chainId, network: data.network, count: data.count }))
      .sort((a, b) => b.count - a.count),
  };
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
  addTxReport(report: TxReportRecord): Promise<boolean>;
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
      // ignore errors when collecting demand stats
    }
    const escrowDemand = buildEscrowDemand(escrowRequests);

    const aggregates: TxAggregates = {
      total: 0,
      symbolCount: new Map(),
      symbolAmount: new Map(),
      netSymCount: new Map(),
      netSymAmount: new Map(),
      netNames: new Map(),
      kindCount: new Map(),
    };
    try {
      const [totalRaw, symCountRaw, symAmountRaw, netSymCountRaw, netSymAmountRaw, netNamesRaw, kindCountRaw] =
        await Promise.all([
          this.redis.get<number>(TX_TOTAL_KEY),
          this.redis.hgetall<Record<string, string | number>>(TX_SYMBOL_COUNT_KEY),
          this.redis.hgetall<Record<string, string | number>>(TX_SYMBOL_AMOUNT_KEY),
          this.redis.hgetall<Record<string, string | number>>(TX_NETSYM_COUNT_KEY),
          this.redis.hgetall<Record<string, string | number>>(TX_NETSYM_AMOUNT_KEY),
          this.redis.hgetall<Record<string, string>>(TX_NETWORK_NAME_KEY),
          this.redis.hgetall<Record<string, string | number>>(TX_KIND_COUNT_KEY),
        ]);
      aggregates.total = Number(totalRaw) || 0;
      aggregates.symbolCount = recordToMap(symCountRaw);
      aggregates.symbolAmount = recordToMap(symAmountRaw);
      aggregates.netSymCount = recordToMap(netSymCountRaw);
      aggregates.netSymAmount = recordToMap(netSymAmountRaw);
      aggregates.netNames = recordToStringMap(netNamesRaw);
      aggregates.kindCount = recordToMap(kindCountRaw);
    } catch (err) {
      console.log(`[relay:store] getStats tx aggregates failed: ${(err as Error).message}`);
    }
    const financial = buildFinancialStats(aggregates);

    return {
      totalWallets,
      onlineWallets,
      totalMessages,
      totalChats,
      totalSystemSignals,
      financial,
      escrowDemand,
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

  async addTxReport(report: TxReportRecord): Promise<boolean> {
    const dedupKey = `${TX_DEDUP_PREFIX}${report.reportId}`;
    const first = await this.redis.set(dedupKey, '1', { nx: true, ex: TX_DEDUP_TTL_S });
    if (first === null) {
      console.log(`[relay:store] addTxReport dedup reportId:${report.reportId}`);
      return false;
    }

    const amount = parseAmount(report.amount);
    const netsym = `${report.chainId}:${report.symbol}`;
    const pipeline = this.redis.multi();
    pipeline.incrby(TX_TOTAL_KEY, 1);
    pipeline.hincrby(TX_SYMBOL_COUNT_KEY, report.symbol, 1);
    pipeline.hincrby(TX_NETSYM_COUNT_KEY, netsym, 1);
    pipeline.hincrby(TX_KIND_COUNT_KEY, report.kind, 1);
    if (amount > 0) {
      pipeline.hincrbyfloat(TX_SYMBOL_AMOUNT_KEY, report.symbol, amount);
      pipeline.hincrbyfloat(TX_NETSYM_AMOUNT_KEY, netsym, amount);
    }
    if (report.network) {
      pipeline.hset(TX_NETWORK_NAME_KEY, { [String(report.chainId)]: report.network });
    }
    await pipeline.exec();
    console.log(`[relay:store] addTxReport chainId:${report.chainId} symbol:${report.symbol} kind:${report.kind}`);
    return true;
  }
}

class MemoryStore implements Store {
  private signals = new Map<string, SignalEnvelope[]>();
  private peers = new Map<string, PeerRecord>();
  private chatMessagesTotal = 0;
  private chatTopics = new Set<string>();
  private escrowRequests: EscrowRequestRecord[] = [];
  private txTotal = 0;
  private txSymbolCount = new Map<string, number>();
  private txSymbolAmount = new Map<string, number>();
  private txNetSymCount = new Map<string, number>();
  private txNetSymAmount = new Map<string, number>();
  private txNetworkNames = new Map<string, string>();
  private txKindCount = new Map<string, number>();
  private txSeen = new Map<string, number>();

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
    const financial = buildFinancialStats({
      total: this.txTotal,
      symbolCount: this.txSymbolCount,
      symbolAmount: this.txSymbolAmount,
      netSymCount: this.txNetSymCount,
      netSymAmount: this.txNetSymAmount,
      netNames: this.txNetworkNames,
      kindCount: this.txKindCount,
    });
    return {
      totalWallets: this.peers.size,
      onlineWallets,
      totalMessages: this.chatMessagesTotal,
      totalChats: this.chatTopics.size,
      totalSystemSignals,
      financial,
      escrowDemand: buildEscrowDemand(this.escrowRequests),
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

  async addTxReport(report: TxReportRecord): Promise<boolean> {
    const seenAt = this.txSeen.get(report.reportId);
    if (seenAt !== undefined && Date.now() - seenAt < TX_DEDUP_TTL_S * 1000) {
      return false;
    }
    this.txSeen.set(report.reportId, Date.now());
    this.txTotal += 1;
    const netsym = `${report.chainId}:${report.symbol}`;
    const amount = parseAmount(report.amount);
    const bump = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
    bump(this.txSymbolCount, report.symbol, 1);
    bump(this.txNetSymCount, netsym, 1);
    bump(this.txKindCount, report.kind, 1);
    if (amount > 0) {
      bump(this.txSymbolAmount, report.symbol, amount);
      bump(this.txNetSymAmount, netsym, amount);
    }
    if (report.network) {
      this.txNetworkNames.set(String(report.chainId), report.network);
    }
    return true;
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
  escrowDemand: EscrowDemandStats;
  updatedAt: string;
}

export type { FinancialStats, EscrowDemandStats };

export type { Store };
