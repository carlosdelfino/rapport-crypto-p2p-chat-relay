import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { scanWallet } from './chain-scan.js';
import type { ScannedTx } from './chain-scan.js';
import type { SignalEnvelope, PeerRecord, EscrowRequestRecord } from './types.js';

const PEER_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_S = 60 * 60;
const CHAT_MESSAGE_COUNTER_KEY = 'stats:chat_messages:total';
const CHAT_TOPIC_SET_KEY = 'stats:chat_topics';
const CHAT_PAIR_COUNTER_KEY = 'stats:chat_pairs';
const CHAT_GROUP_MSGS_KEY = 'stats:chat_group_msgs';
const SEEN_WALLETS_KEY = 'stats:wallets';
const CHAIN_EDGES_KEY = 'stats:chain_edges';
const CHAIN_EDGES_TTL_S = 30 * 60;
const WALLET_SCAN_CACHE_TTL_S = 30 * 60;
const SCAN_WALLET_LIMIT = 20;
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

interface WalletGraphNode {
  id: string;
  label: string;
  group: 'wallet' | 'group' | 'aggregate';
  value: number;
  online: boolean;
}

interface WalletGraphLink {
  source: string;
  target: string;
  chat: number;
  transactions: number;
  kinds: Record<string, number>;
  assets: Record<string, number>;
  escrowRequests: number;
}

interface WalletGraph {
  nodes: WalletGraphNode[];
  links: WalletGraphLink[];
}

interface ChainEdge {
  a: string;
  b: string;
  transactions: number;
  kinds: Record<string, number>;
  assets: Record<string, number>;
}

function normWallet(address: string): string {
  return /^0x/i.test(address) ? address.toLowerCase() : address;
}

function walletNodeId(address: string): string {
  return `w_${createHash('sha256').update(normWallet(address)).digest('hex').slice(0, 8)}`;
}

function groupNodeId(topic: string): string {
  return `g_${createHash('sha256').update(topic).digest('hex').slice(0, 12)}`;
}

function pairKey(a: string, b: string): string {
  return [normWallet(a), normWallet(b)].sort().join(':');
}

function extractChatParticipants(envelope: SignalEnvelope): string[] {
  const members = new Set<string>();
  if (envelope.from) members.add(normWallet(envelope.from));
  if (envelope.to) members.add(normWallet(envelope.to));
  if (envelope.topic.startsWith('chat.v1.direct.')) {
    const addrs = envelope.topic.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    for (const addr of addrs) members.add(normWallet(addr));
  }
  return [...members].filter((m) => m.length > 0);
}

function isGroupChatTopic(topic: string): boolean {
  return topic.startsWith('/chat/v1/group/');
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

function accumulateAssets(target: Record<string, number>, symbol: string, amount: number): void {
  if (amount <= 0) return;
  target[symbol] = (target[symbol] ?? 0) + amount;
}

function getOrCreateLink(map: Map<string, WalletGraphLink>, source: string, target: string): WalletGraphLink {
  const key = `${source}|${target}`;
  let link = map.get(key);
  if (!link) {
    link = { source, target, chat: 0, transactions: 0, kinds: {}, assets: {}, escrowRequests: 0 };
    map.set(key, link);
  }
  return link;
}

function buildWalletGraph(
  wallets: string[],
  onlineWallets: Set<string>,
  chatPairs: Map<string, number>,
  chatGroupMsgs: Map<string, number>,
  chainEdges: ChainEdge[],
  escrowRequests: EscrowRequestRecord[],
): WalletGraph {
  const walletIds = new Map<string, string>();
  for (const w of wallets) walletIds.set(normWallet(w), walletNodeId(w));
  const links = new Map<string, WalletGraphLink>();

  for (const [key, count] of chatPairs) {
    const [a, b] = key.split(':');
    const source = walletIds.get(a);
    const target = walletIds.get(b);
    if (!source || !target) continue;
    const [s, t] = [source, target].sort();
    getOrCreateLink(links, s, t).chat += count;
  }

  const groupIds = new Set<string>();
  for (const [field, count] of chatGroupMsgs) {
    const idx = field.indexOf(':');
    if (idx <= 0) continue;
    const gid = `g_${field.slice(0, idx)}`;
    const source = walletIds.get(field.slice(idx + 1));
    if (!source) continue;
    groupIds.add(gid);
    getOrCreateLink(links, source, gid).chat += count;
  }

  for (const edge of chainEdges) {
    const source = walletIds.get(normWallet(edge.a));
    const target = walletIds.get(normWallet(edge.b));
    if (!source || !target) continue;
    const [s, t] = [source, target].sort();
    const link = getOrCreateLink(links, s, t);
    link.transactions += edge.transactions;
    for (const [k, v] of Object.entries(edge.kinds)) link.kinds[k] = (link.kinds[k] ?? 0) + v;
    for (const [k, v] of Object.entries(edge.assets)) accumulateAssets(link.assets, k, v);
  }

  let hasEscrow = false;
  for (const req of escrowRequests) {
    const source = walletIds.get(normWallet(req.requesterWallet));
    if (!source) continue;
    hasEscrow = true;
    const link = getOrCreateLink(links, source, 'escrow');
    link.escrowRequests += 1;
    accumulateAssets(link.assets, req.symbol || 'UNKNOWN', parseAmount(req.amount));
  }

  const activity = new Map<string, number>();
  const bump = (id: string, v: number) => activity.set(id, (activity.get(id) ?? 0) + v);
  for (const link of links.values()) {
    const v = link.chat + link.transactions + link.escrowRequests;
    bump(link.source, v);
    bump(link.target, v);
  }

  const nodes: WalletGraphNode[] = wallets.map((w) => {
    const id = walletNodeId(w);
    return {
      id,
      label: `Carteira ${id.slice(2)}`,
      group: 'wallet' as const,
      value: activity.get(id) ?? 0,
      online: onlineWallets.has(normWallet(w)),
    };
  });
  for (const gid of groupIds) {
    nodes.push({ id: gid, label: `Grupo ${gid.slice(2, 8)}`, group: 'group', value: activity.get(gid) ?? 0, online: false });
  }
  if (hasEscrow) {
    nodes.push({ id: 'escrow', label: 'Escrow', group: 'aggregate', value: activity.get('escrow') ?? 0, online: false });
  }

  return { nodes, links: [...links.values()] };
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

      const participants = extractChatParticipants(envelope);
      if (isGroupChatTopic(topic)) {
        const sender = normWallet(envelope.from);
        if (sender) {
          const groupSha = createHash('sha256').update(topic).digest('hex').slice(0, 16);
          await this.redis.hincrby(CHAT_GROUP_MSGS_KEY, `${groupSha}:${sender}`, 1);
        }
      } else {
        for (let i = 0; i < participants.length; i++) {
          for (let j = i + 1; j < participants.length; j++) {
            await this.redis.hincrby(CHAT_PAIR_COUNTER_KEY, pairKey(participants[i], participants[j]), 1);
          }
        }
      }
      if (participants.length) {
        await this.redis.sadd(SEEN_WALLETS_KEY, participants[0], ...participants.slice(1));
      }
    } else if (envelope.type === 'chat_request' && envelope.from && envelope.to) {
      const a = normWallet(envelope.from);
      const b = normWallet(envelope.to);
      await this.redis.hincrby(CHAT_PAIR_COUNTER_KEY, pairKey(a, b), 1);
      await this.redis.sadd(SEEN_WALLETS_KEY, a, b);
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

    let walletGraph: WalletGraph = { nodes: [], links: [] };
    try {
      walletGraph = await this.buildGraph(escrowRequests);
    } catch (err) {
      console.log(`[relay:store] getStats graph build failed: ${(err as Error).message}`);
    }

    return {
      totalWallets,
      onlineWallets,
      totalMessages,
      totalChats,
      totalSystemSignals,
      financial,
      walletGraph,
      updatedAt: new Date().toISOString(),
    };
  }

  private async getWalletUniverse(escrowRequests: EscrowRequestRecord[]): Promise<{ wallets: string[]; online: Set<string>; chainHints: Map<string, number> }> {
    const now = Date.now();
    const [peerWallets, onlineMembers, seenWallets, peerRecords] = await Promise.all([
      this.redis.hkeys('peers').catch(() => [] as string[]),
      this.redis.zrange<string[]>('peers:online', now - PEER_TTL_MS, '+inf', { byScore: true }).catch(() => [] as string[]),
      this.redis.smembers<string[]>(SEEN_WALLETS_KEY).catch(() => [] as string[]),
      this.redis.hgetall<Record<string, string>>('peers').catch(() => null),
    ]);

    const online = new Set((onlineMembers ?? []).map(normWallet));
    const chainHints = new Map<string, number>();
    if (peerRecords) {
      for (const [wallet, raw] of Object.entries(peerRecords)) {
        try {
          const record = JSON.parse(raw) as PeerRecord;
          if (record.chainId) chainHints.set(normWallet(wallet), record.chainId);
        } catch {
          // ignore malformed peer records
        }
      }
    }

    const seen = new Set<string>();
    const wallets: string[] = [];
    const push = (addr?: string) => {
      const n = normWallet(addr ?? '');
      if (n && !seen.has(n)) {
        seen.add(n);
        wallets.push(n);
      }
    };
    for (const w of onlineMembers ?? []) push(w);
    for (const w of peerWallets ?? []) push(w);
    for (const w of seenWallets ?? []) push(w);
    for (const r of escrowRequests) push(r.requesterWallet);
    return { wallets, online, chainHints };
  }

  private async scanWalletCached(wallet: string, chainId?: number): Promise<ScannedTx[]> {
    const key = `scan:tx:${normWallet(wallet)}`;
    try {
      const cached = await this.redis.get<{ fetchedAt: number; txs: ScannedTx[] }>(key);
      if (cached && Array.isArray(cached.txs) && Date.now() - cached.fetchedAt < WALLET_SCAN_CACHE_TTL_S * 1000) {
        return cached.txs;
      }
    } catch {
      // fall through to remote scan
    }
    const txs = await scanWallet(wallet, chainId);
    try {
      await this.redis.set(key, { fetchedAt: Date.now(), txs }, { ex: WALLET_SCAN_CACHE_TTL_S });
    } catch {
      // caching is best-effort
    }
    return txs;
  }

  private async getChainEdges(wallets: string[], chainHints: Map<string, number>): Promise<ChainEdge[]> {
    try {
      const cached = await this.redis.get<{ updatedAt: number; edges: ChainEdge[] }>(CHAIN_EDGES_KEY);
      if (cached && Array.isArray(cached.edges) && Date.now() - cached.updatedAt < CHAIN_EDGES_TTL_S * 1000) {
        return cached.edges;
      }
    } catch {
      // recompute below
    }

    const walletSet = new Set(wallets.map(normWallet));
    const toScan = wallets.slice(0, SCAN_WALLET_LIMIT);
    const results = await Promise.allSettled(
      toScan.map(async (w) => ({ wallet: w, txs: await this.scanWalletCached(w, chainHints.get(normWallet(w))) })),
    );

    const acc = new Map<string, { a: string; b: string; hashes: Set<string>; unhashed: number; kinds: Record<string, number>; assets: Record<string, number> }>();
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const owner = normWallet(res.value.wallet);
      for (const tx of res.value.txs) {
        const cp = normWallet(tx.counterparty);
        if (!cp || cp === owner || !walletSet.has(cp)) continue;
        const [a, b] = [owner, cp].sort();
        const key = `${a}:${b}`;
        let edge = acc.get(key);
        if (!edge) {
          edge = { a, b, hashes: new Set(), unhashed: 0, kinds: {}, assets: {} };
          acc.set(key, edge);
        }
        if (tx.hash) edge.hashes.add(tx.hash);
        else edge.unhashed += 1;
        edge.kinds[tx.kind] = (edge.kinds[tx.kind] ?? 0) + 1;
        accumulateAssets(edge.assets, tx.symbol, tx.amount);
      }
    }

    const edges: ChainEdge[] = [...acc.values()].map((e) => ({
      a: e.a,
      b: e.b,
      transactions: e.hashes.size + e.unhashed,
      kinds: e.kinds,
      assets: e.assets,
    }));

    try {
      await this.redis.set(CHAIN_EDGES_KEY, { updatedAt: Date.now(), edges }, { ex: CHAIN_EDGES_TTL_S });
    } catch {
      // caching is best-effort
    }
    return edges;
  }

  private hashCounterToMap(raw: Record<string, string | number> | null): Map<string, number> {
    const map = new Map<string, number>();
    if (!raw) return map;
    for (const [field, value] of Object.entries(raw)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) map.set(field, n);
    }
    return map;
  }

  private async buildGraph(escrowRequests: EscrowRequestRecord[]): Promise<WalletGraph> {
    const { wallets, online, chainHints } = await this.getWalletUniverse(escrowRequests);
    const [pairRaw, groupRaw] = await Promise.all([
      this.redis.hgetall<Record<string, string | number>>(CHAT_PAIR_COUNTER_KEY).catch(() => null),
      this.redis.hgetall<Record<string, string | number>>(CHAT_GROUP_MSGS_KEY).catch(() => null),
    ]);
    const chatPairs = this.hashCounterToMap(pairRaw);
    const chatGroupMsgs = this.hashCounterToMap(groupRaw);
    const chainEdges = await this.getChainEdges(wallets, chainHints);
    return buildWalletGraph(wallets, online, chatPairs, chatGroupMsgs, chainEdges, escrowRequests);
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
  private chatPairs = new Map<string, number>();
  private chatGroupMsgs = new Map<string, number>();
  private seenWallets = new Set<string>();
  private chainEdgesCache: { updatedAt: number; edges: ChainEdge[] } | null = null;
  private walletScanCache = new Map<string, { fetchedAt: number; txs: ScannedTx[] }>();
  private escrowRequests: EscrowRequestRecord[] = [];

  async addSignal(topic: string, envelope: SignalEnvelope): Promise<void> {
    const list = this.signals.get(topic) ?? [];
    list.push(envelope);
    this.signals.set(topic, list);

    if (isChatMessage(envelope)) {
      this.chatMessagesTotal++;
      this.chatTopics.add(topic);

      const participants = extractChatParticipants(envelope);
      if (isGroupChatTopic(topic)) {
        const sender = normWallet(envelope.from);
        if (sender) {
          const groupSha = createHash('sha256').update(topic).digest('hex').slice(0, 16);
          const field = `${groupSha}:${sender}`;
          this.chatGroupMsgs.set(field, (this.chatGroupMsgs.get(field) ?? 0) + 1);
        }
      } else {
        for (let i = 0; i < participants.length; i++) {
          for (let j = i + 1; j < participants.length; j++) {
            const key = pairKey(participants[i], participants[j]);
            this.chatPairs.set(key, (this.chatPairs.get(key) ?? 0) + 1);
          }
        }
      }
      for (const p of participants) this.seenWallets.add(p);
    } else if (envelope.type === 'chat_request' && envelope.from && envelope.to) {
      const a = normWallet(envelope.from);
      const b = normWallet(envelope.to);
      const key = pairKey(a, b);
      this.chatPairs.set(key, (this.chatPairs.get(key) ?? 0) + 1);
      this.seenWallets.add(a);
      this.seenWallets.add(b);
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
    const walletGraph = await this.buildGraph();
    return {
      totalWallets: this.peers.size,
      onlineWallets,
      totalMessages: this.chatMessagesTotal,
      totalChats: this.chatTopics.size,
      totalSystemSignals,
      financial,
      walletGraph,
      updatedAt: new Date().toISOString(),
    };
  }

  private async scanWalletCached(wallet: string, chainId?: number): Promise<ScannedTx[]> {
    const key = normWallet(wallet);
    const cached = this.walletScanCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < WALLET_SCAN_CACHE_TTL_S * 1000) {
      return cached.txs;
    }
    const txs = await scanWallet(wallet, chainId);
    this.walletScanCache.set(key, { fetchedAt: Date.now(), txs });
    return txs;
  }

  private async getChainEdges(wallets: string[], chainHints: Map<string, number>): Promise<ChainEdge[]> {
    if (this.chainEdgesCache && Date.now() - this.chainEdgesCache.updatedAt < CHAIN_EDGES_TTL_S * 1000) {
      return this.chainEdgesCache.edges;
    }

    const walletSet = new Set(wallets.map(normWallet));
    const toScan = wallets.slice(0, SCAN_WALLET_LIMIT);
    const results = await Promise.allSettled(
      toScan.map(async (w) => ({ wallet: w, txs: await this.scanWalletCached(w, chainHints.get(normWallet(w))) })),
    );

    const acc = new Map<string, { a: string; b: string; hashes: Set<string>; unhashed: number; kinds: Record<string, number>; assets: Record<string, number> }>();
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const owner = normWallet(res.value.wallet);
      for (const tx of res.value.txs) {
        const cp = normWallet(tx.counterparty);
        if (!cp || cp === owner || !walletSet.has(cp)) continue;
        const [a, b] = [owner, cp].sort();
        const key = `${a}:${b}`;
        let edge = acc.get(key);
        if (!edge) {
          edge = { a, b, hashes: new Set(), unhashed: 0, kinds: {}, assets: {} };
          acc.set(key, edge);
        }
        if (tx.hash) edge.hashes.add(tx.hash);
        else edge.unhashed += 1;
        edge.kinds[tx.kind] = (edge.kinds[tx.kind] ?? 0) + 1;
        accumulateAssets(edge.assets, tx.symbol, tx.amount);
      }
    }

    const edges: ChainEdge[] = [...acc.values()].map((e) => ({
      a: e.a,
      b: e.b,
      transactions: e.hashes.size + e.unhashed,
      kinds: e.kinds,
      assets: e.assets,
    }));
    this.chainEdgesCache = { updatedAt: Date.now(), edges };
    return edges;
  }

  private async buildGraph(): Promise<WalletGraph> {
    const now = Date.now();
    const online = new Set<string>();
    const chainHints = new Map<string, number>();
    const seen = new Set<string>();
    const wallets: string[] = [];
    const push = (addr?: string) => {
      const n = normWallet(addr ?? '');
      if (n && !seen.has(n)) {
        seen.add(n);
        wallets.push(n);
      }
    };
    for (const record of this.peers.values()) {
      const n = normWallet(record.wallet);
      if (record.lastSeen >= now - PEER_TTL_MS) {
        online.add(n);
        push(n);
      }
    }
    for (const record of this.peers.values()) {
      push(record.wallet);
      if (record.chainId) chainHints.set(normWallet(record.wallet), record.chainId);
    }
    for (const w of this.seenWallets) push(w);
    for (const r of this.escrowRequests) push(r.requesterWallet);

    const chainEdges = await this.getChainEdges(wallets, chainHints);
    return buildWalletGraph(wallets, online, this.chatPairs, this.chatGroupMsgs, chainEdges, this.escrowRequests);
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
  walletGraph: WalletGraph;
  updatedAt: string;
}

export type { FinancialStats, WalletGraph, WalletGraphNode, WalletGraphLink, ChainEdge };

export type { Store };
