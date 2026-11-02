/**
 * Banlist enforcement for the Cloudflare relay: same semantics as the
 * Vercel relay (static env overrides > 60s in-memory cache > on-chain
 * `isBanned` read via JSON-RPC `eth_call`). In-memory cache replaces the
 * Redis ban-flag cache; a warm hub DO keeps it effectively global.
 */
import { normalizeAddress } from './auth.js';

const BAN_FLAG_TTL_MS = 60 * 1000;
// isBanned(address) selector
const IS_BANNED_SELECTOR = '0x97f735d5';

interface Env {
  BAN_DAO_ADDRESS?: string;
  POLYGON_RPC_URL?: string;
  BANNED_WALLETS?: string;
}

export class BanlistService {
  private readonly cache = new Map<string, { banned: boolean; checkedAt: number }>();
  private readonly overrides = new Map<string, boolean>();
  private readonly dao: string | null;
  private readonly rpcUrl: string;

  constructor(env: Env) {
    this.dao = env.BAN_DAO_ADDRESS ? normalizeAddress(env.BAN_DAO_ADDRESS) : null;
    this.rpcUrl = env.POLYGON_RPC_URL?.trim() || 'https://polygon-rpc.com';
    for (const raw of (env.BANNED_WALLETS ?? '').split(',')) {
      const wallet = normalizeAddress(raw);
      if (wallet) this.overrides.set(wallet.toLowerCase(), true);
    }
  }

  async isBanned(wallet: string): Promise<boolean> {
    const normalized = normalizeAddress(wallet);
    if (!normalized) return false;
    const key = normalized.toLowerCase();
    if (this.overrides.get(key)) return true;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.checkedAt <= BAN_FLAG_TTL_MS) return cached.banned;

    const onChain = await this.readOnChain(normalized);
    if (onChain === null) return cached?.banned ?? false;
    this.cache.set(key, { banned: onChain, checkedAt: Date.now() });
    return onChain;
  }

  private async readOnChain(wallet: `0x${string}`): Promise<boolean | null> {
    if (!this.dao) return false;
    try {
      const data = `${IS_BANNED_SELECTOR}${wallet.slice(2).toLowerCase().padStart(64, '0')}`;
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: this.dao, data }, 'latest'],
        }),
      });
      const json = (await response.json()) as { result?: string };
      if (typeof json.result !== 'string' || json.result.length < 66) return null;
      return json.result.endsWith('1');
    } catch (err) {
      console.warn(`[relay:banlist] isBanned failed wallet:${wallet} err:${(err as Error).message}`);
      return null;
    }
  }
}
