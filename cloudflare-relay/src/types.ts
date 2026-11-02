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

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
  details?: Record<string, unknown>;
  next_step?: string;
}

export interface Env {
  SIGNALING_HUB: DurableObjectNamespace;
  RELAY_CLIENT_KEYS?: string;
  RELAY_REQUIRE_SIGNATURE?: string;
  ALLOWED_ORIGINS?: string;
  BAN_DAO_ADDRESS?: string;
  POLYGON_RPC_URL?: string;
  BANNED_WALLETS?: string;
}
