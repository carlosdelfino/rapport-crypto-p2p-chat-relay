import { verifyMessage } from 'viem';

export interface SignedPayload {
  signature?: string;
  wallet: string;
  timestamp: number;
  payload?: string;
}

export function isSignatureRequired(): boolean {
  return process.env.RELAY_REQUIRE_SIGNATURE === 'true';
}

export async function verifyRequestSignature(
  wallet: string,
  message: string,
  signature?: string
): Promise<boolean> {
  if (!signature) return false;
  try {
    return await verifyMessage({
      address: wallet as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

export function isRecentTimestamp(timestamp: number, windowSeconds = 300): boolean {
  const now = Date.now();
  return Math.abs(now - timestamp) <= windowSeconds * 1000;
}
