import type { OnrampSessionRequest } from '@circle-fin/onramp-kit/protocol';

export class OnrampInputError extends Error {
  constructor() { super('Invalid onramp request. Use bounded strings and at most 16 items per asset collection.'); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OnrampInputError();
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new OnrampInputError();
  const cleaned = value.trim();
  if (!cleaned) throw new OnrampInputError();
  return cleaned;
}

function collection<T>(value: unknown, parse: (item: unknown) => T): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new OnrampInputError();
  return value.map(parse);
}

export function parseOnrampInput(value: unknown): OnrampSessionRequest {
  const body = record(value);
  const appUserId = text(body.appUserId, 128);
  const destinationAddress = text(body.destinationAddress, 42).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(destinationAddress)) throw new OnrampInputError();
  if (body.assets === undefined) return { appUserId, destinationAddress };
  const assets = record(body.assets);
  const parsed = {
    tokens: collection(assets.tokens, (item) => text(item, 64)),
    chains: collection(assets.chains, (item) => text(item, 64)),
    pairs: collection(assets.pairs, (item) => {
      const pair = record(item);
      return { token: text(pair.token, 64), chain: text(pair.chain, 64) };
    }),
  };
  return { appUserId, destinationAddress, assets: parsed };
}
