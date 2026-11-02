/**
 * One-shot import of the current Upstash Redis state into Postgres.
 * Covers: p2p_peers (hash + p2p_peers:online zset), p2p_signals (signal:* lists),
 * chat counters/topics, ban flags/overrides, escrow requests and tx
 * aggregates. Idempotent — every write is an upsert/ON CONFLICT.
 *
 * Usage: npx tsx scripts/postgres-import-redis.ts
 * Env:   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (source)
 *        POSTGRES_URL / POSTGRES_PRISMA_URL / POSTGRES_HOST+POSTGRES_DATABASE (target)
 */
import 'dotenv/config';
import { Redis } from '@upstash/redis';
import postgres from 'postgres';
import { postgresConfigured } from '../lib/store-postgres.js';
import type { PeerRecord, SignalEnvelope, EscrowRequestRecord, BanFlagRecord } from '../lib/types.js';


function parseJson<T>(item: unknown): T | null {
  try {
    return (typeof item === 'string' ? JSON.parse(item) : item) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('[pg:import] Upstash source not configured (UPSTASH_REDIS_REST_URL / _TOKEN).');
    process.exit(1);
  }
  if (!postgresConfigured()) {
    console.error('[pg:import] Postgres target not configured.');
    process.exit(1);
  }
  const redis = new Redis({ url, token });
  const pgUrl = process.env.POSTGRES_URL?.trim() || process.env.POSTGRES_PRISMA_URL?.trim();
  const sql = pgUrl
    ? postgres(pgUrl, { ssl: 'require', max: 2 })
    : postgres({
        host: process.env.POSTGRES_HOST,
        database: process.env.POSTGRES_DATABASE,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ssl: 'require',
        max: 2,
      });

  const summary: Record<string, number> = {};
  try {
    // ---- p2p_peers --------------------------------------------------------
    const peerHash = await redis.hgetall<Record<string, string>>('p2p_peers');
    for (const raw of Object.values(peerHash ?? {})) {
      const peer = parseJson<PeerRecord>(raw);
      if (!peer?.wallet) continue;
      await sql`
        INSERT INTO p2p_peers (wallet, peer_id, chain_id, multiaddrs, ts, last_seen, signature)
        VALUES (${peer.wallet}, ${peer.peerId}, ${peer.chainId}, ${sql.json(peer.multiaddrs ?? [])}, ${peer.timestamp}, ${peer.lastSeen}, ${peer.signature ?? null})
        ON CONFLICT (wallet) DO UPDATE SET
          peer_id = EXCLUDED.peer_id, chain_id = EXCLUDED.chain_id,
          multiaddrs = EXCLUDED.multiaddrs, ts = EXCLUDED.ts,
          last_seen = GREATEST(p2p_peers.last_seen, EXCLUDED.last_seen), signature = EXCLUDED.signature`;
      summary.p2p_peers = (summary.p2p_peers ?? 0) + 1;
    }

    // ---- p2p_signals ------------------------------------------------------
    const signalKeys = await redis.keys('signal:*');
    for (const key of signalKeys) {
      const topic = key.slice('signal:'.length);
      const items = await redis.lrange(key, 0, -1);
      for (const item of items) {
        const envelope = parseJson<SignalEnvelope>(item);
        if (!envelope?.id) continue;
        await sql`
          INSERT INTO p2p_signals (id, topic, type, payload, from_wallet, to_wallet, ts, signature)
          VALUES (${envelope.id}, ${topic}, ${envelope.type}, ${envelope.payload}, ${envelope.from}, ${envelope.to ?? null}, ${envelope.timestamp}, ${envelope.signature ?? null})
          ON CONFLICT (id) DO NOTHING`;
        summary.p2p_signals = (summary.p2p_signals ?? 0) + 1;
      }
    }

    // ---- chat stats ---------------------------------------------------
    const chatTotal = await redis.hget<number>('stats:chat_messages:total', 'total');
    if (typeof chatTotal === 'number' && chatTotal > 0) {
      await sql`
        INSERT INTO p2p_stats_counters (bucket, field, count) VALUES ('total', 'stats:chat_messages:total', ${chatTotal})
        ON CONFLICT (bucket, field) DO UPDATE SET count = GREATEST(p2p_stats_counters.count, EXCLUDED.count)`;
      summary.chat_messages = chatTotal;
    }
    const chatTopics = await redis.smembers('stats:p2p_chat_topics');
    for (const topic of chatTopics ?? []) {
      await sql`INSERT INTO p2p_chat_topics (topic) VALUES (${topic}) ON CONFLICT DO NOTHING`;
      summary.p2p_chat_topics = (summary.p2p_chat_topics ?? 0) + 1;
    }

    // ---- ban state ----------------------------------------------------
    const banFlags = await redis.hgetall<Record<string, string>>('ban:flags');
    for (const [wallet, raw] of Object.entries(banFlags ?? {})) {
      const flag = parseJson<BanFlagRecord>(raw);
      if (!flag) continue;
      await sql`
        INSERT INTO p2p_ban_state (wallet, banned, checked_at) VALUES (${wallet}, ${flag.banned}, ${flag.checkedAt})
        ON CONFLICT (wallet) DO UPDATE SET banned = EXCLUDED.banned, checked_at = GREATEST(p2p_ban_state.checked_at, EXCLUDED.checked_at)`;
      summary.ban_flags = (summary.ban_flags ?? 0) + 1;
    }
    const banOverrides = await redis.hgetall<Record<string, string>>('ban:overrides');
    for (const [wallet, value] of Object.entries(banOverrides ?? {})) {
      const banned = value === '1';
      await sql`
        INSERT INTO p2p_ban_state (wallet, banned, checked_at, override) VALUES (${wallet}, ${banned}, ${Date.now()}, ${banned})
        ON CONFLICT (wallet) DO UPDATE SET override = EXCLUDED.override, banned = EXCLUDED.banned`;
      summary.ban_overrides = (summary.ban_overrides ?? 0) + 1;
    }

    // ---- escrow requests ----------------------------------------------
    const escrowItems = await redis.lrange('escrow:requests', 0, -1);
    for (const item of escrowItems) {
      const request = parseJson<EscrowRequestRecord>(item);
      if (!request?.escrowId) continue;
      await sql`
        INSERT INTO p2p_escrow_requests (escrow_id, chain_id, payload, received_at)
        VALUES (${request.escrowId}, ${request.chainId}, ${sql.json(request as unknown as postgres.JSONValue)}, ${request.receivedAt})
        ON CONFLICT (escrow_id) DO NOTHING`;
      summary.p2p_escrow_requests = (summary.p2p_escrow_requests ?? 0) + 1;
    }

    // ---- tx aggregates ------------------------------------------------
    const txBuckets: Array<[string, string]> = [
      ['stats:tx:vol:symbol', 'symbol'],
      ['stats:tx:cnt:symbol', 'symbol'],
      ['stats:tx:vol:netsym', 'netsym'],
      ['stats:tx:cnt:netsym', 'netsym'],
      ['stats:tx:cnt:kind', 'kind'],
    ];
    for (const [redisKey, bucket] of txBuckets) {
      const isAmount = redisKey.includes(':vol:');
      const fields = await redis.hgetall<Record<string, string | number>>(redisKey);
      for (const [field, value] of Object.entries(fields ?? {})) {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        if (isAmount) {
          await sql`
            INSERT INTO p2p_stats_counters (bucket, field, amount) VALUES (${bucket}, ${field}, ${n})
            ON CONFLICT (bucket, field) DO UPDATE SET amount = GREATEST(p2p_stats_counters.amount, EXCLUDED.amount)`;
        } else {
          await sql`
            INSERT INTO p2p_stats_counters (bucket, field, count) VALUES (${bucket}, ${field}, ${n})
            ON CONFLICT (bucket, field) DO UPDATE SET count = GREATEST(p2p_stats_counters.count, EXCLUDED.count)`;
        }
        summary[`tx_${bucket}`] = (summary[`tx_${bucket}`] ?? 0) + 1;
      }
    }
    const txTotal = await redis.get<number>('stats:tx:total');
    if (typeof txTotal === 'number' && txTotal > 0) {
      await sql`
        INSERT INTO p2p_stats_counters (bucket, field, count) VALUES ('total', 'tx', ${txTotal})
        ON CONFLICT (bucket, field) DO UPDATE SET count = GREATEST(p2p_stats_counters.count, EXCLUDED.count)`;
      summary.tx_total = txTotal;
    }
    const netNames = await redis.hgetall<Record<string, string>>('stats:tx:net:name');
    for (const [chainId, name] of Object.entries(netNames ?? {})) {
      await sql`
        INSERT INTO p2p_stats_meta (key, value) VALUES (${'tx:netname:' + chainId}, ${name})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      summary.tx_netnames = (summary.tx_netnames ?? 0) + 1;
    }

    console.log(`[pg:import] done - ${JSON.stringify(summary)}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(`[pg:import] failed: ${err.message}`);
  process.exit(1);
});
