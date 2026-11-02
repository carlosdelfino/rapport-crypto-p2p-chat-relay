import { getAddress, verifyMessage } from 'viem';

export const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export function normalizeAddress(raw: string): `0x${string}` | null {
  try {
    return getAddress(raw.toLowerCase().trim() as `0x${string}`);
  } catch {
    return null;
  }
}

export function isRecentTimestamp(timestamp: number, windowSeconds = 300): boolean {
  return Math.abs(Date.now() - timestamp) <= windowSeconds * 1000;
}

export function isSignatureRequired(env: { RELAY_REQUIRE_SIGNATURE?: string }): boolean {
  return env.RELAY_REQUIRE_SIGNATURE !== 'false';
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time hex digest comparison of the client credential. */
export async function clientKeyMatches(candidate: string, configuredKeys: string): Promise<boolean> {
  const candidateDigest = await sha256Hex(candidate);
  for (const key of configuredKeys.split(',').map((k) => k.trim()).filter(Boolean)) {
    const keyDigest = await sha256Hex(key);
    if (keyDigest.length === candidateDigest.length) {
      let diff = 0;
      for (let i = 0; i < keyDigest.length; i++) diff |= keyDigest.charCodeAt(i) ^ candidateDigest.charCodeAt(i);
      if (diff === 0) return true;
    }
  }
  return false;
}
