import type { IncomingMessage, ServerResponse } from 'node:http';

export interface VercelRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(obj: unknown): void;
}
