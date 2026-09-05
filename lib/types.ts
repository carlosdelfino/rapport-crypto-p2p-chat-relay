export type SignalType = 'offer' | 'answer' | 'ice' | 'chat_request';

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
