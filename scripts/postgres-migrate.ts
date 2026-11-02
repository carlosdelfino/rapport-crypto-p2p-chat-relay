/**
 * Creates (and idempotently updates) the Postgres schema used by
 * PostgresStore. Safe to re-run — every statement is IF NOT EXISTS /
 * idempotent, so this is also the schema "update" path.
 *
 * Usage: npx tsx scripts/postgres-migrate.ts
 * Env:   POSTGRES_URL | POSTGRES_PRISMA_URL |
 *        POSTGRES_HOST + POSTGRES_DATABASE (+POSTGRES_USER, POSTGRES_PASSWORD)
 */
import 'dotenv/config';
import postgres from 'postgres';
import { postgresConfigured } from '../lib/store-postgres.js';

const DDL = `
CREATE TABLE IF NOT EXISTS p2p_signals (
  id         text        PRIMARY KEY,
  topic      text        NOT NULL,
  type       text        NOT NULL,
  payload    text        NOT NULL,
  from_wallet text       NOT NULL,
  to_wallet  text,
  ts         bigint      NOT NULL,
  signature  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_signals_topic_id ON p2p_signals (topic, id);
CREATE INDEX IF NOT EXISTS p2p_signals_ts       ON p2p_signals (ts);

CREATE TABLE IF NOT EXISTS p2p_peers (
  wallet     text   PRIMARY KEY,
  peer_id    text   NOT NULL,
  chain_id   int    NOT NULL,
  multiaddrs jsonb,
  ts         bigint NOT NULL,
  last_seen  bigint NOT NULL,
  signature  text
);
CREATE INDEX IF NOT EXISTS p2p_peers_last_seen ON p2p_peers (last_seen);

CREATE TABLE IF NOT EXISTS p2p_ban_state (
  wallet     text    PRIMARY KEY,
  banned     boolean NOT NULL DEFAULT false,
  checked_at bigint  NOT NULL DEFAULT 0,
  override   boolean
);

CREATE TABLE IF NOT EXISTS p2p_escrow_requests (
  escrow_id   text   PRIMARY KEY,
  chain_id    int    NOT NULL,
  payload     jsonb  NOT NULL,
  received_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS p2p_escrow_requests_received ON p2p_escrow_requests (received_at DESC);

CREATE TABLE IF NOT EXISTS p2p_tx_seen (
  report_id text   PRIMARY KEY,
  seen_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS p2p_stats_counters (
  bucket text    NOT NULL,
  field  text    NOT NULL DEFAULT '',
  count  numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, field)
);

CREATE TABLE IF NOT EXISTS p2p_stats_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS p2p_chat_topics (
  topic text PRIMARY KEY
);
`;

async function main(): Promise<void> {
  if (!postgresConfigured()) {
    console.error('[pg:migrate] Postgres not configured. Set POSTGRES_URL / POSTGRES_PRISMA_URL or POSTGRES_HOST+POSTGRES_DATABASE.');
    process.exit(1);
  }
  const url = process.env.POSTGRES_URL?.trim() || process.env.POSTGRES_PRISMA_URL?.trim();
  const sql = url
    ? postgres(url, { ssl: 'require', max: 1 })
    : postgres({
        host: process.env.POSTGRES_HOST,
        database: process.env.POSTGRES_DATABASE,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ssl: 'require',
        max: 1,
      });
  try {
    await sql.unsafe(DDL);
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    console.log(`[pg:migrate] schema applied. tables: ${tables.map((t) => t.table_name).join(', ')}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(`[pg:migrate] failed: ${err.message}`);
  process.exit(1);
});
