import { createPublicClient, getAddress, http, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { createStore } from './store.js';
import type { BanProposalRecord } from './types.js';

/**
 * Espelho da BanQuadraticDAO (Polygon) para o relay: expõe as votações
 * abertas na página /ban e aplica a banlist nos endpoints /signal e
 * /peers. A fonte de verdade é a chain; o Redis guarda um cache por
 * carteira (TTL curto) e overrides assinados pela carteira de suporte.
 */

const SUPPORT_WALLET = '0x7010A4C4c189AB421028a622e2A2e623f432d18e';
const BAN_FLAG_TTL_MS = 60 * 1000;
const PROPOSAL_PAGE_SIZE = 200;
const PROPOSAL_STATE_ACTIVE = 1;
const PROPOSAL_STATE_EXECUTED = 6;

const BAN_DAO_ABI = [
  {
    type: 'function',
    name: 'isBanned',
    stateMutability: 'view',
    inputs: [{ name: 'target', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'listProposals',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      {
        name: 'items',
        type: 'tuple[]',
        components: [
          { name: 'proposalId', type: 'uint256' },
          { name: 'proposer', type: 'address' },
          { name: 'target', type: 'address' },
          { name: 'reasonHash', type: 'bytes32' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'votingDeadline', type: 'uint64' },
          { name: 'executedAt', type: 'uint64' },
          { name: 'forWeight', type: 'uint256' },
          { name: 'againstWeight', type: 'uint256' },
          { name: 'state', type: 'uint8' },
        ],
      },
    ],
  },
] as const;

interface OnChainProposal {
  proposalId: bigint;
  proposer: `0x${string}`;
  target: `0x${string}`;
  reasonHash: `0x${string}`;
  createdAt: bigint;
  votingDeadline: bigint;
  executedAt: bigint;
  forWeight: bigint;
  againstWeight: bigint;
  state: number;
}

let client: PublicClient | null = null;

/** Endereço da DAO configurado via env; sem ele o recurso fica inativo. */
export function banDaoAddress(): `0x${string}` | null {
  const raw = process.env.BAN_DAO_ADDRESS?.trim();
  if (!raw) return null;
  try {
    return getAddress(raw as `0x${string}`);
  } catch {
    return null;
  }
}

/** Carteira administradora (suporte) autorizada a assinar overrides. */
export function banAdminWallet(): string {
  const raw = process.env.BAN_ADMIN_WALLET?.trim() || SUPPORT_WALLET;
  try {
    return getAddress(raw as `0x${string}`);
  } catch {
    return SUPPORT_WALLET;
  }
}

export function isBanFeatureEnabled(): boolean {
  return banDaoAddress() !== null;
}

function getClient(): PublicClient | null {
  if (client) return client;
  const rpcUrl = process.env.POLYGON_RPC_URL?.trim() || 'https://polygon-rpc.com';
  client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  return client;
}

function toRecord(p: OnChainProposal): BanProposalRecord {
  return {
    proposalId: p.proposalId.toString(),
    requester: p.proposer,
    target: p.target,
    reasonHash: p.reasonHash,
    createdAt: Number(p.createdAt),
    votingDeadline: Number(p.votingDeadline),
    forWeight: p.forWeight.toString(),
    againstWeight: p.againstWeight.toString(),
    state: p.state,
  };
}

/** Propostas em votação (state Active e deadline no futuro). */
export async function getOpenBanProposals(): Promise<BanProposalRecord[]> {
  const dao = banDaoAddress();
  const rpc = getClient();
  if (!dao || !rpc) return [];
  try {
    const items = (await rpc.readContract({
      address: dao,
      abi: BAN_DAO_ABI,
      functionName: 'listProposals',
      args: [0n, BigInt(PROPOSAL_PAGE_SIZE)],
    })) as OnChainProposal[];
    const now = Math.floor(Date.now() / 1000);
    return items
      .map(toRecord)
      .filter((p) => p.state === PROPOSAL_STATE_ACTIVE && p.votingDeadline > now);
  } catch (err) {
    console.warn(`[relay:banlist] listProposals failed: ${(err as Error).message}`);
    return [];
  }
}

async function readIsBannedOnChain(wallet: `0x${string}`): Promise<boolean | null> {
  const dao = banDaoAddress();
  const rpc = getClient();
  if (!dao || !rpc) return null;
  try {
    return (await rpc.readContract({
      address: dao,
      abi: BAN_DAO_ABI,
      functionName: 'isBanned',
      args: [wallet],
    })) as boolean;
  } catch (err) {
    console.warn(`[relay:banlist] isBanned failed wallet:${wallet} err:${(err as Error).message}`);
    return null;
  }
}

/**
 * Decide se a carteira está banida: override admin > cache fresco >
 * leitura on-chain (que popula o cache) > cache obsoleto > false.
 */
export async function isBannedWallet(wallet: string): Promise<boolean> {
  let normalized: `0x${string}`;
  try {
    normalized = getAddress(wallet as `0x${string}`);
  } catch {
    return false;
  }

  const store = createStore();
  const overrides = await store.getBanOverrides();
  const override = overrides[normalized] ?? overrides[wallet];
  if (override === true) return true;

  const cached = await store.getBanFlag(normalized);
  if (cached && Date.now() - cached.checkedAt <= BAN_FLAG_TTL_MS) {
    return cached.banned;
  }

  const onChain = await readIsBannedOnChain(normalized);
  if (onChain === null) {
    return cached?.banned ?? false;
  }
  await store.setBanFlag(normalized, onChain);
  return onChain;
}

/**
 * Reconsulta on-chain o flag das carteiras dadas (ou dos alvos das
 * propostas recentes quando vazio) e atualiza o cache. Chamado pelo
 * POST /api/ban assinado pelo suporte.
 */
export async function refreshBanFlags(targets: string[] = []): Promise<number> {
  const store = createStore();
  let wallets = targets;
  if (wallets.length === 0) {
    const dao = banDaoAddress();
    const rpc = getClient();
    if (!dao || !rpc) return 0;
    try {
      const items = (await rpc.readContract({
        address: dao,
        abi: BAN_DAO_ABI,
        functionName: 'listProposals',
        args: [0n, BigInt(PROPOSAL_PAGE_SIZE)],
      })) as OnChainProposal[];
      wallets = items.map((p) => p.target);
    } catch {
      return 0;
    }
  }

  let refreshed = 0;
  for (const raw of wallets) {
    try {
      const wallet = getAddress(raw as `0x${string}`);
      const banned = await readIsBannedOnChain(wallet);
      if (banned !== null) {
        await store.setBanFlag(wallet, banned);
        refreshed++;
      }
    } catch {
      // ignora endereços inválidos
    }
  }
  console.log(`[relay:banlist] refreshBanFlags refreshed:${refreshed}`);
  return refreshed;
}

/** Override manual assinado pelo admin; também grava no cache. */
export async function setBanOverride(wallet: string, banned: boolean): Promise<void> {
  const normalized = getAddress(wallet as `0x${string}`);
  const store = createStore();
  await store.setBanOverride(normalized, banned);
  await store.setBanFlag(normalized, banned);
  console.log(`[relay:banlist] override wallet:${normalized} banned:${banned}`);
}

export { PROPOSAL_STATE_ACTIVE, PROPOSAL_STATE_EXECUTED };
