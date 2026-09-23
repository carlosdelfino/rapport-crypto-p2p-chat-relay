/**
 * Descoberta de interações on-chain entre carteiras.
 *
 * Usa explorers públicos por tipo de endereço:
 *   - EVM: Etherscan v2 (multichain, requer ETHERSCAN_API_KEY) ou Blockscout
 *     público (sem chave) para as chains mapeadas.
 *   - Bitcoin: mempool.space
 *   - Stellar: Horizon público
 *   - Solana: JSON-RPC público (mainnet-beta)
 *
 * Nenhum endereço é exposto ao cliente — os resultados são usados apenas para
 * montar arestas agregadas do grafo de interações.
 */

export interface ScannedTx {
  counterparty: string;
  kind: 'native' | 'token' | 'contract' | 'payment';
  amount: number;
  symbol: string;
  hash?: string;
  timestamp?: number;
  chain: string;
}

const SCAN_TX_LIMIT = 50;
const SCAN_TIMEOUT_MS = 6000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const SATS_PER_BTC = 100_000_000;
const WEI_PER_NATIVE = 1e18;

const NATIVE_SYMBOL_BY_CHAIN: Record<number, string> = {
  1: 'ETH',
  10: 'ETH',
  56: 'BNB',
  100: 'xDAI',
  137: 'POL',
  8453: 'ETH',
  42161: 'ETH',
  11155111: 'ETH',
  80002: 'POL',
};

const BLOCKSCOUT_BY_CHAIN: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  100: 'https://gnosis.blockscout.com',
  137: 'https://polygon.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
};

export type ChainKind = 'evm' | 'bitcoin' | 'stellar' | 'solana' | 'unknown';

export function detectChainKind(address: string): ChainKind {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'evm';
  if (/^G[A-Z2-7]{55}$/.test(address)) return 'stellar';
  if (/^(bc1|tb1)[a-z0-9]{20,90}$/i.test(address)) return 'bitcoin';
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return 'bitcoin';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
  return 'unknown';
}

function normWallet(address: string): string {
  return /^0x/i.test(address) ? address.toLowerCase() : address;
}

function parseAmount(value: unknown): number {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

interface RawTx {
  counterparty: string;
  kind: ScannedTx['kind'];
  amount: number;
  symbol: string;
  hash?: string;
  timestamp?: number;
}

async function scanEvmEtherscan(wallet: string, chainId: number): Promise<RawTx[]> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return [];
  const symbol = NATIVE_SYMBOL_BY_CHAIN[chainId] ?? 'ETH';
  const base = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&address=${wallet}&startblock=0&endblock=99999999&page=1&offset=${SCAN_TX_LIMIT}&sort=desc&apikey=${key}`;

  const out: RawTx[] = [];
  const [txlist, tokentx] = await Promise.allSettled([
    fetchJson(`${base}&action=txlist`),
    fetchJson(`${base}&action=tokentx`),
  ]);

  if (txlist.status === 'fulfilled') {
    const result = (txlist.value as { result?: unknown }).result;
    if (Array.isArray(result)) {
      for (const tx of result as Array<Record<string, unknown>>) {
        if (String(tx.isError) === '1') continue;
        const from = String(tx.from ?? '');
        const to = String(tx.to ?? '');
        const counterparty = normWallet(from.toLowerCase() === wallet.toLowerCase() ? to : from);
        if (!counterparty) continue;
        const input = String(tx.input ?? '');
        out.push({
          counterparty,
          kind: input.length > 10 ? 'contract' : 'native',
          amount: parseAmount(tx.value) / WEI_PER_NATIVE,
          symbol,
          hash: typeof tx.hash === 'string' ? tx.hash : undefined,
          timestamp: Number(tx.timeStamp) ? Number(tx.timeStamp) * 1000 : undefined,
        });
      }
    }
  }

  if (tokentx.status === 'fulfilled') {
    const result = (tokentx.value as { result?: unknown }).result;
    if (Array.isArray(result)) {
      for (const tx of result as Array<Record<string, unknown>>) {
        const from = String(tx.from ?? '');
        const to = String(tx.to ?? '');
        const counterparty = normWallet(from.toLowerCase() === wallet.toLowerCase() ? to : from);
        if (!counterparty) continue;
        const decimals = Number(tx.tokenDecimal) || 18;
        out.push({
          counterparty,
          kind: 'token',
          amount: parseAmount(tx.value) / 10 ** decimals,
          symbol: String(tx.tokenSymbol ?? 'TOKEN'),
          hash: typeof tx.hash === 'string' ? tx.hash : undefined,
          timestamp: Number(tx.timeStamp) ? Number(tx.timeStamp) * 1000 : undefined,
        });
      }
    }
  }
  return out;
}

async function scanEvmBlockscout(wallet: string, chainId: number): Promise<RawTx[]> {
  const base = BLOCKSCOUT_BY_CHAIN[chainId];
  if (!base) return [];
  const symbol = NATIVE_SYMBOL_BY_CHAIN[chainId] ?? 'ETH';
  const out: RawTx[] = [];

  const [txs, tokens] = await Promise.allSettled([
    fetchJson(`${base}/api/v2/addresses/${wallet}/transactions?filter=to%20%7C%20from`),
    fetchJson(`${base}/api/v2/addresses/${wallet}/token-transfers?type=ERC-20`),
  ]);

  if (txs.status === 'fulfilled') {
    const items = (txs.value as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const tx of items.slice(0, SCAN_TX_LIMIT) as Array<Record<string, unknown>>) {
        const from = String((tx.from as Record<string, unknown>)?.hash ?? '');
        const to = String((tx.to as Record<string, unknown> | null)?.hash ?? '');
        const counterparty = normWallet(from.toLowerCase() === wallet.toLowerCase() ? to : from);
        if (!counterparty) continue;
        const types = Array.isArray(tx.tx_types) ? (tx.tx_types as string[]) : [];
        out.push({
          counterparty,
          kind: types.includes('coin_transfer') ? 'native' : 'contract',
          amount: parseAmount(tx.value) / WEI_PER_NATIVE,
          symbol,
          hash: typeof tx.hash === 'string' ? tx.hash : undefined,
          timestamp: tx.timestamp ? Date.parse(String(tx.timestamp)) : undefined,
        });
      }
    }
  }

  if (tokens.status === 'fulfilled') {
    const items = (tokens.value as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const tx of items.slice(0, SCAN_TX_LIMIT) as Array<Record<string, unknown>>) {
        const from = String((tx.from as Record<string, unknown>)?.hash ?? '');
        const to = String((tx.to as Record<string, unknown> | null)?.hash ?? '');
        const counterparty = normWallet(from.toLowerCase() === wallet.toLowerCase() ? to : from);
        if (!counterparty) continue;
        const token = (tx.token as Record<string, unknown>) ?? {};
        const total = (tx.total as Record<string, unknown>) ?? {};
        const decimals = Number(total.decimals ?? token.decimals) || 18;
        out.push({
          counterparty,
          kind: 'token',
          amount: parseAmount(total.value) / 10 ** decimals,
          symbol: String(token.symbol ?? 'TOKEN'),
          hash: typeof tx.transaction_hash === 'string' ? tx.transaction_hash : undefined,
          timestamp: tx.timestamp ? Date.parse(String(tx.timestamp)) : undefined,
        });
      }
    }
  }
  return out;
}

async function scanBitcoin(wallet: string): Promise<RawTx[]> {
  const data = await fetchJson(`https://mempool.space/api/address/${wallet}/txs`);
  if (!Array.isArray(data)) return [];
  const out: RawTx[] = [];
  for (const tx of data.slice(0, SCAN_TX_LIMIT) as Array<Record<string, unknown>>) {
    const vin = Array.isArray(tx.vin) ? tx.vin : [];
    const vout = Array.isArray(tx.vout) ? tx.vout : [];
    const senders = vin
      .map((v) => String(((v as { prevout?: Record<string, unknown> }).prevout?.scriptpubkey_address) ?? ''))
      .filter((a) => a.length > 0);
    const sentByWallet = senders.includes(wallet);
    const hash = typeof tx.txid === 'string' ? tx.txid : undefined;
    if (sentByWallet) {
      for (const o of vout as Array<Record<string, unknown>>) {
        const addr = String(o.scriptpubkey_address ?? '');
        if (!addr || addr === wallet) continue;
        out.push({ counterparty: normWallet(addr), kind: 'payment', amount: parseAmount(o.value) / SATS_PER_BTC, symbol: 'BTC', hash });
      }
    } else {
      const received = (vout as Array<Record<string, unknown>>)
        .filter((o) => String(o.scriptpubkey_address ?? '') === wallet)
        .reduce((sum, o) => sum + parseAmount(o.value), 0);
      for (const sender of new Set(senders.filter((a) => a !== wallet))) {
        out.push({ counterparty: normWallet(sender), kind: 'payment', amount: received / SATS_PER_BTC, symbol: 'BTC', hash });
      }
    }
  }
  return out;
}

async function scanStellar(wallet: string): Promise<RawTx[]> {
  const data = await fetchJson(
    `https://horizon.stellar.org/accounts/${wallet}/payments?limit=${SCAN_TX_LIMIT}&order=desc`,
  );
  const records = (data as { _embedded?: { records?: unknown[] } })._embedded?.records;
  if (!Array.isArray(records)) return [];
  const out: RawTx[] = [];
  for (const rec of records as Array<Record<string, unknown>>) {
    const from = String(rec.from ?? '');
    const to = String(rec.to ?? rec.into ?? '');
    const counterparty = normWallet(from === wallet ? to : from);
    if (!counterparty) continue;
    const assetType = String(rec.asset_type ?? 'native');
    const symbol = assetType === 'native' ? 'XLM' : String(rec.asset_code ?? 'ASSET');
    const amount = parseAmount(rec.amount ?? rec.starting_balance);
    out.push({
      counterparty,
      kind: 'payment',
      amount,
      symbol,
      hash: typeof rec.transaction_hash === 'string' ? rec.transaction_hash : undefined,
      timestamp: rec.created_at ? Date.parse(String(rec.created_at)) : undefined,
    });
  }
  return out;
}

async function scanSolana(wallet: string): Promise<RawTx[]> {
  const rpc = 'https://api.mainnet-beta.solana.com';
  const sigResp = await fetchJson(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [wallet, { limit: 25 }],
    }),
  }) as { result?: Array<{ signature?: string }> };
  const signatures = (sigResp.result ?? [])
    .map((s) => s.signature)
    .filter((s): s is string => typeof s === 'string')
    .slice(0, 25);
  if (!signatures.length) return [];

  const batch = signatures.map((sig, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'getTransaction',
    params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
  }));
  const txResp = await fetchJson(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
  const list = Array.isArray(txResp) ? txResp : [txResp];
  const out: RawTx[] = [];
  for (const entry of list as Array<{ result?: Record<string, unknown> | null }>) {
    const tx = entry?.result;
    if (!tx) continue;
    const message = (tx.transaction as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
    const meta = tx.meta as Record<string, unknown> | undefined;
    const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
    const pre = Array.isArray(meta?.preBalances) ? (meta.preBalances as number[]) : [];
    const post = Array.isArray(meta?.postBalances) ? (meta.postBalances as number[]) : [];
    const walletIndex = keys.findIndex(
      (k) => String((k as Record<string, unknown>).pubkey ?? k) === wallet,
    );
    if (walletIndex < 0) continue;
    const walletDelta = (post[walletIndex] ?? 0) - (pre[walletIndex] ?? 0);
    for (let i = 0; i < keys.length; i++) {
      if (i === walletIndex) continue;
      const key = keys[i] as Record<string, unknown>;
      const pubkey = String(key.pubkey ?? key);
      const isSigner = key.signer === true;
      const delta = (post[i] ?? 0) - (pre[i] ?? 0);
      const interacted = isSigner || (walletDelta < 0 && delta > 0) || (walletDelta > 0 && delta < 0);
      if (!interacted) continue;
      const txSigs = (tx.transaction as { signatures?: string[] } | undefined)?.signatures;
      out.push({
        counterparty: pubkey,
        kind: 'native',
        amount: Math.abs(walletDelta) / LAMPORTS_PER_SOL,
        symbol: 'SOL',
        hash: Array.isArray(txSigs) ? txSigs[0] : undefined,
        timestamp: tx.blockTime ? Number(tx.blockTime) * 1000 : undefined,
      });
    }
  }
  return out;
}

/**
 * Retorna as transações recentes de uma carteira, com a contraparte.
 * Nunca lança exceção — falhas de rede/explorer retornam [].
 */
export async function scanWallet(wallet: string, chainId?: number): Promise<ScannedTx[]> {
  const kind = detectChainKind(wallet);
  try {
    let txs: RawTx[] = [];
    if (kind === 'evm') {
      const id = chainId ?? 1;
      txs = process.env.ETHERSCAN_API_KEY
        ? await scanEvmEtherscan(wallet, id)
        : await scanEvmBlockscout(wallet, id);
    } else if (kind === 'bitcoin') {
      txs = await scanBitcoin(wallet);
    } else if (kind === 'stellar') {
      txs = await scanStellar(wallet);
    } else if (kind === 'solana') {
      txs = await scanSolana(wallet);
    }
    return txs.map((t) => ({ ...t, chain: kind }));
  } catch (err) {
    console.log(`[relay:scan] scanWallet failed wallet:${wallet.slice(0, 10)}… kind:${kind} err:${(err as Error).message}`);
    return [];
  }
}
