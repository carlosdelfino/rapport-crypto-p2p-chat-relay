import postgres from 'postgres';
import type { SignalEnvelope, PeerRecord, EscrowRequestRecord, TxReportRecord, BanFlagRecord } from './types.js';
import type { Store, RelayStats, FinancialStats, EscrowDemandStats } from './store.js';

const PEER_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_MS = 60 * 60 * 1000;
const ESCROW_REQUESTS_MAX = 500;
const TX_DEDUP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const CHAT_TOTAL = 'stats:chat_messages:total';

function isChatTopic(topic: string): boolean {
  return topic.startsWith('chat.v1.direct.') || topic.startsWith('/chat/v1/group/');
}

function isChatMessage(envelope: SignalEnvelope): boolean {
  return envelope.type === 'data' && isChatTopic(envelope.topic);
}

function parseAmount(amount: string): number {
  const normalized = String(amount).replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildFinancialStats(rows: Array<{ bucket: string; field: string; count: number; amount: number }>, netNames: Map<string, string>): FinancialStats {
  const volumeBySymbol: Array<{ symbol: string; count: number; amount: number }> = [];
  const countByKind: Array<{ kind: string; count: number }> = [];
  const networks = new Map<number, { chainId: number; network: string; count: number; symbols: Array<{ symbol: string; count: number; amount: number }> }>();
  let totalTransactions = 0;

  for (const row of rows) {
    if (row.bucket === 'total') totalTransactions = row.count;
    else if (row.bucket === 'symbol') volumeBySymbol.push({ symbol: row.field, count: row.count, amount: row.amount });
    else if (row.bucket === 'kind') countByKind.push({ kind: row.field, count: row.count });
    else if (row.bucket === 'netsym') {
      const idx = row.field.indexOf(':');
      if (idx <= 0) continue;
      const chainId = Number(row.field.slice(0, idx));
      const symbol = row.field.slice(idx + 1);
      if (!Number.isInteger(chainId) || !symbol) continue;
      let net = networks.get(chainId);
      if (!net) {
        net = { chainId, network: netNames.get(String(chainId)) ?? `chainId ${chainId}`, count: 0, symbols: [] };
        networks.set(chainId, net);
      }
      net.count += row.count;
      net.symbols.push({ symbol, count: row.count, amount: row.amount });
    }
  }

  const volumeByNetwork = [...networks.values()]
    .map((net) => ({ ...net, symbols: net.symbols.sort((a, b) => b.amount - a.amount || b.count - a.count) }))
    .sort((a, b) => b.count - a.count);

  return {
    totalTransactions,
    volumeBySymbol: volumeBySymbol.sort((a, b) => b.amount - a.amount || b.count - a.count),
    volumeByNetwork,
    countByKind: countByKind.sort((a, b) => b.count - a.count),
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
    const net = byNetwork.get(request.chainId) ?? { network: request.networkName || `chainId ${request.chainId}`, count: 0 };
    net.count += 1;
    if (request.networkName) net.network = request.networkName;
    byNetwork.set(request.chainId, net);
  }
  return {
    totalRequests: requests.length,
    bySymbol: [...bySymbol.entries()].map(([symbol, data]) => ({ symbol, count: data.count, amount: data.amount })).sort((a, b) => b.amount - a.amount || b.count - a.count),
    byNetwork: [...byNetwork.entries()].map(([chainId, data]) => ({ chainId, network: data.network, count: data.count })).sort((a, b) => b.count - a.count),
  };
}

export function postgresConfigured(): boolean {
  return Boolean(process.env.POSTGRES_URL?.trim() || process.env.POSTGRES_PRISMA_URL?.trim() || (process.env.POSTGRES_HOST?.trim() && process.env.POSTGRES_DATABASE?.trim()));
}

/**
 * Postgres-backed Store (Neon/Vercel Postgres). Replaces the Upstash hot
 * path: each request costs a few cheap SQL statements instead of billed
 * Redis commands. Connection comes from POSTGRES_URL / POSTGRES_PRISMA_URL
 * or the POSTGRES_HOST+POSTGRES_DATABASE(+POSTGRES_USER/PASSWORD) pair;
 * SSL is required by default (Neon).
 */
let sharedSql: postgres.Sql | undefined;

/**
 * Shared connection pool for the warm serverless instance. Every
 * PostgresStore in the same instance must reuse this pool — the Neon
 * session-mode pooler caps total clients (~15), and per-store pools
 * multiplied by endpoints and cold starts exhaust it (EMAXCONNSESSION).
 * `max: 1` keeps a single connection per instance; `idle_timeout`
 * releases it quickly between invocations.
 */
function getSql(): postgres.Sql {
  if (sharedSql) return sharedSql;
  const url = process.env.POSTGRES_URL?.trim() || process.env.POSTGRES_PRISMA_URL?.trim();
  const options = { ssl: 'require' as const, max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false };
  sharedSql = url
    ? postgres(url, options)
    : postgres({
        host: process.env.POSTGRES_HOST,
        database: process.env.POSTGRES_DATABASE,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ...options,
      });
  console.log(`[${new Date().toISOString()}] [store:constructor] info Postgres backend initialized (shared pool max:1)`);
  return sharedSql;
}

export class PostgresStore implements Store {
  private readonly sql: postgres.Sql;

  constructor() {
    this.sql = getSql();
  }

  async addSignal(topic: string, envelope: SignalEnvelope): Promise<void> {
    await this.sql`
      INSERT INTO p2p_signals (id, topic, type, payload, from_wallet, to_wallet, ts, signature)
      VALUES (${envelope.id}, ${topic}, ${envelope.type}, ${envelope.payload}, ${envelope.from}, ${envelope.to ?? null}, ${envelope.timestamp}, ${envelope.signature ?? null})
      ON CONFLICT (id) DO NOTHING`;
    if (isChatMessage(envelope)) {
      await this.sql`
        INSERT INTO p2p_stats_counters (bucket, field, count) VALUES ('total', ${CHAT_TOTAL}, 1)
        ON CONFLICT (bucket, field) DO UPDATE SET count = p2p_stats_counters.count + 1`;
      await this.sql`INSERT INTO p2p_chat_topics (topic) VALUES (${topic}) ON CONFLICT DO NOTHING`;
    }
  }

  async getSignals(topic: string, opts?: { since?: string; to?: string }): Promise<SignalEnvelope[]> {
    const minTs = Date.now() - SIGNAL_TTL_MS;
    const rows = await this.sql`
      SELECT id, topic, type, payload, from_wallet, to_wallet, ts, signature
      FROM p2p_signals
      WHERE topic = ${topic} AND ts >= ${minTs}
        AND (${opts?.since ?? null}::text IS NULL OR id > ${opts?.since ?? ''})
        AND (${opts?.to ?? null}::text IS NULL OR to_wallet IS NULL OR lower(to_wallet) = lower(${opts?.to ?? ''}))
      ORDER BY id`;
    return rows.map((r) => ({
      id: r.id as string,
      topic: r.topic as string,
      type: r.type as SignalEnvelope['type'],
      payload: r.payload as string,
      from: r.from_wallet as string,
      to: (r.to_wallet as string | null) ?? undefined,
      timestamp: Number(r.ts),
      signature: (r.signature as string | null) ?? undefined,
    }));
  }

  async deleteSignalsBefore(topic: string, beforeId: string): Promise<number> {
    const rows = await this.sql`DELETE FROM p2p_signals WHERE topic = ${topic} AND id <= ${beforeId} RETURNING id`;
    if (rows.length) console.log(`[relay:store] deleteSignalsBefore topic:${topic} trimmed:${rows.length}`);
    return rows.length;
  }

  async addPeer(peer: PeerRecord): Promise<void> {
    await this.sql`
      INSERT INTO p2p_peers (wallet, peer_id, chain_id, multiaddrs, ts, last_seen, signature)
      VALUES (${peer.wallet}, ${peer.peerId}, ${peer.chainId}, ${this.sql.json(peer.multiaddrs ?? [])}, ${peer.timestamp}, ${Date.now()}, ${peer.signature ?? null})
      ON CONFLICT (wallet) DO UPDATE SET
        peer_id = EXCLUDED.peer_id, chain_id = EXCLUDED.chain_id,
        multiaddrs = EXCLUDED.multiaddrs, ts = EXCLUDED.ts,
        last_seen = EXCLUDED.last_seen, signature = EXCLUDED.signature`;
  }

  private rowToPeer(r: Record<string, unknown>): PeerRecord {
    return {
      wallet: r.wallet as string,
      peerId: r.peer_id as string,
      chainId: Number(r.chain_id),
      multiaddrs: (r.multiaddrs as string[] | null) ?? [],
      timestamp: Number(r.ts),
      lastSeen: Number(r.last_seen),
      signature: (r.signature as string | null) ?? undefined,
    };
  }

  async getPeer(wallet: string): Promise<PeerRecord | null> {
    const rows = await this.sql`SELECT * FROM p2p_peers WHERE wallet = ${wallet}`;
    if (!rows.length) return null;
    const record = this.rowToPeer(rows[0]);
    return Date.now() - record.lastSeen <= PEER_TTL_MS ? record : null;
  }

  async getPeers(minLastSeen?: number): Promise<PeerRecord[]> {
    const threshold = minLastSeen ?? Date.now() - PEER_TTL_MS;
    const rows = await this.sql`SELECT * FROM p2p_peers WHERE last_seen >= ${threshold}`;
    return rows.map((r) => this.rowToPeer(r));
  }

  async removePeer(wallet: string): Promise<void> {
    await this.sql`DELETE FROM p2p_peers WHERE wallet = ${wallet}`;
  }

  async getStats(): Promise<RelayStats> {
    const now = Date.now();
    const [totalWalletsRow] = await this.sql`SELECT count(*)::int AS c FROM p2p_peers`;
    const [onlineRow] = await this.sql`SELECT count(*)::int AS c FROM p2p_peers WHERE last_seen >= ${now - PEER_TTL_MS}`;
    const [chatRow] = await this.sql`SELECT count::numeric AS n FROM p2p_stats_counters WHERE bucket = 'total' AND field = ${CHAT_TOTAL}`;
    const [topicsRow] = await this.sql`SELECT count(*)::int AS c FROM p2p_chat_topics`;
    const [signalsRow] = await this.sql`SELECT count(*)::int AS c FROM p2p_signals WHERE ts >= ${now - SIGNAL_TTL_MS}`;
    const counterRows = await this.sql`SELECT bucket, field, count::numeric AS count, amount::numeric AS amount FROM p2p_stats_counters WHERE bucket <> 'total' OR field <> ${CHAT_TOTAL}`;
    const metaRows = await this.sql`SELECT key, value FROM p2p_stats_meta WHERE key LIKE 'tx:netname:%'`;
    const netNames = new Map(metaRows.map((r) => [(r.key as string).slice('tx:netname:'.length), r.value as string]));
    const escrowRequests = await this.getEscrowRequests();

    return {
      totalWallets: Number(totalWalletsRow?.c ?? 0),
      onlineWallets: Number(onlineRow?.c ?? 0),
      totalMessages: Number(chatRow?.n ?? 0),
      totalChats: Number(topicsRow?.c ?? 0),
      totalSystemSignals: Number(signalsRow?.c ?? 0),
      financial: buildFinancialStats(counterRows.map((r) => ({ bucket: r.bucket as string, field: r.field as string, count: Number(r.count), amount: Number(r.amount) })), netNames),
      escrowDemand: buildEscrowDemand(escrowRequests),
      updatedAt: new Date().toISOString(),
    };
  }

  async addEscrowRequest(request: EscrowRequestRecord): Promise<void> {
    const inserted = await this.sql`
      INSERT INTO p2p_escrow_requests (escrow_id, chain_id, payload, received_at)
      VALUES (${request.escrowId}, ${request.chainId}, ${this.sql.json(request as unknown as postgres.JSONValue)}, ${request.receivedAt})
      ON CONFLICT (escrow_id) DO NOTHING
      RETURNING escrow_id`;
    if (!inserted.length) {
      console.log(`[relay:store] addEscrowRequest dedup escrowId:${request.escrowId}`);
      return;
    }
    await this.sql`
      DELETE FROM p2p_escrow_requests WHERE escrow_id NOT IN (
        SELECT escrow_id FROM p2p_escrow_requests ORDER BY received_at DESC LIMIT ${ESCROW_REQUESTS_MAX})`;
  }

  async getEscrowRequests(chainId?: number): Promise<EscrowRequestRecord[]> {
    const rows = chainId !== undefined
      ? await this.sql`SELECT payload FROM p2p_escrow_requests WHERE chain_id = ${chainId} ORDER BY received_at DESC`
      : await this.sql`SELECT payload FROM p2p_escrow_requests ORDER BY received_at DESC`;
    return rows.map((r) => r.payload as EscrowRequestRecord);
  }

  async addTxReport(report: TxReportRecord): Promise<boolean> {
    const dedup = await this.sql`
      INSERT INTO p2p_tx_seen (report_id, seen_at) VALUES (${report.reportId}, ${Date.now()})
      ON CONFLICT (report_id) DO NOTHING
      RETURNING report_id`;
    if (!dedup.length) return false;
    await this.sql`DELETE FROM p2p_tx_seen WHERE seen_at < ${Date.now() - TX_DEDUP_TTL_MS}`;

    const amount = parseAmount(report.amount);
    const netsym = `${report.chainId}:${report.symbol}`;
    const bump = (bucket: string, field: string, count: number, amt: number) => this.sql`
      INSERT INTO p2p_stats_counters (bucket, field, count, amount) VALUES (${bucket}, ${field}, ${count}, ${amt})
      ON CONFLICT (bucket, field) DO UPDATE SET
        count = p2p_stats_counters.count + ${count},
        amount = p2p_stats_counters.amount + ${amt}`;
    await bump('total', 'tx', 1, 0);
    await bump('symbol', report.symbol, 1, amount);
    await bump('netsym', netsym, 1, amount);
    await bump('kind', report.kind, 1, 0);
    if (report.network) {
      await this.sql`
        INSERT INTO p2p_stats_meta (key, value) VALUES (${'tx:netname:' + report.chainId}, ${report.network})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
    return true;
  }

  async getBanFlag(wallet: string): Promise<BanFlagRecord | null> {
    const rows = await this.sql`SELECT banned, checked_at FROM p2p_ban_state WHERE wallet = ${wallet}`;
    if (!rows.length) return null;
    return { banned: rows[0].banned as boolean, checkedAt: Number(rows[0].checked_at) };
  }

  async setBanFlag(wallet: string, banned: boolean): Promise<void> {
    await this.sql`
      INSERT INTO p2p_ban_state (wallet, banned, checked_at) VALUES (${wallet}, ${banned}, ${Date.now()})
      ON CONFLICT (wallet) DO UPDATE SET banned = EXCLUDED.banned, checked_at = EXCLUDED.checked_at`;
  }

  async getBanOverrides(): Promise<Record<string, boolean>> {
    const rows = await this.sql`SELECT wallet, banned FROM p2p_ban_state WHERE override IS NOT NULL`;
    const out: Record<string, boolean> = {};
    for (const r of rows) out[r.wallet as string] = r.banned as boolean;
    return out;
  }

  async setBanOverride(wallet: string, banned: boolean): Promise<void> {
    await this.sql`
      INSERT INTO p2p_ban_state (wallet, banned, checked_at, override) VALUES (${wallet}, ${banned}, ${Date.now()}, ${banned})
      ON CONFLICT (wallet) DO UPDATE SET banned = EXCLUDED.banned, checked_at = EXCLUDED.checked_at, override = ${banned}`;
  }
}
