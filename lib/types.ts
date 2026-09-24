export type SignalType = 'offer' | 'answer' | 'ice' | 'chat_request' | 'data';

export interface SignalEnvelope {
  id: string;
  topic: string;
  type: SignalType;
  payload: string;
  from: string;
  to?: string;
  timestamp: number;
  signature?: string;
}

export interface PeerRecord {
  wallet: string;
  peerId: string;
  chainId: number;
  multiaddrs?: string[];
  timestamp: number;
  lastSeen: number;
  signature?: string;
}

/**
 * Pedido de suporte de escrow para uma rede sem contrato deployado.
 * Criado pelo dApp quando um usuário tenta /escrow numa rede ainda sem
 * EscrowVault — o gestor usa GET /api/escrow-request para acompanhar.
 */
export interface EscrowRequestRecord {
  /** UUID do escrow off-chain no app do pagador. */
  escrowId: string;
  requesterWallet: string;
  chainId: number;
  networkName: string;
  amount: string;
  symbol: string;
  timestamp: number;
  receivedAt: number;
  signature?: string;
}

/**
 * Relato anônimo de volume transacionado, enviado pelo dApp após uma
 * transação on-chain bem-sucedida (pagamento direto ou depósito de escrow).
 * Não contém carteiras, txHash nem assinatura — dedup por reportId (uuid
 * gerado no cliente) para tolerar retries sem dupla contagem.
 */
export interface TxReportRecord {
  /** UUID gerado pelo dApp para deduplicação. */
  reportId: string;
  chainId: number;
  network: string;
  symbol: string;
  amount: string;
  kind: string;
  timestamp: number;
  receivedAt: number;
}

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
  details?: Record<string, unknown>;
  next_step?: string;
}
