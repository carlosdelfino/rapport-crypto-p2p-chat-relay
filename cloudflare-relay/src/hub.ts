import { ADDRESS_REGEX, isRecentTimestamp, isSignatureRequired, normalizeAddress, verifyRequestSignature } from './auth.js';
import { BanlistService } from './banlist.js';
import { ProtectionService } from './protection.js';
import type { ApiResponse, Env, PeerRecord, SignalEnvelope, SignalType } from './types.js';

const PEER_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_MS = 60 * 60 * 1000;
const MAX_PAYLOAD_LENGTH = 64 * 1024;
const MAX_SIGNALS_PER_TOPIC = 500;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const SIGNAL_TYPES: ReadonlySet<SignalType> = new Set(['offer', 'answer', 'ice', 'chat_request', 'data']);

interface SessionAttachment {
  wallet?: string;
  topics: string[];
}

function json<T>(body: ApiResponse<T>, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function reject429(retryAfterMs: number, cooldownUntil: number, reason: string): Response {
  return json({
    code: 429,
    message: 'Please wait before sending again. Your connection will resume automatically after cooldown.',
    details: { reason, retry_after_ms: retryAfterMs, cooldown_until: cooldownUntil },
    next_step: 'Wait for Retry-After before retrying. Do not send requests during cooldown.',
    nest_step: 'Wait for Retry-After before retrying.',
  } as ApiResponse, 429, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
}

async function digest(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Single global Durable Object holding all signaling state: per-topic
 * signal lists, peer presence, rate-limit state, ban cache and live
 * WebSocket sessions. All hot-path operations run in memory — the only
 * persistent writes are signal lists and peer records (for DO restarts),
 * consumed as DO storage ops rather than Upstash commands.
 */
export class SignalingHub implements DurableObject {
  private readonly signals = new Map<string, SignalEnvelope[]>();
  private readonly peers = new Map<string, PeerRecord>();
  private readonly protection = new ProtectionService();
  private readonly banlist: BanlistService;
  private readonly loadedTopics = new Set<string>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.banlist = new BanlistService(env);
    ctx.blockConcurrencyWhile(async () => {
      const storedPeers = await ctx.storage.get<Record<string, PeerRecord>>('peers');
      if (storedPeers) {
        for (const [wallet, record] of Object.entries(storedPeers)) this.peers.set(wallet, record);
      }
      await this.scheduleSweep();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const ipKey = await digest(ip);

    if (url.pathname === '/ws') return this.handleWebSocket(request, url);

    const decision = this.protection.check(ipKey, request.method === 'POST' && url.pathname === '/api/signal');
    if (decision.reason !== 'allowed') return reject429(decision.retryAfterMs, decision.cooldownUntil, decision.reason);
    const failure = this.protection.failures(ipKey);
    if (failure.reason !== 'allowed') return reject429(failure.retryAfterMs, failure.cooldownUntil, failure.reason);

    try {
      if (url.pathname === '/api/signal') {
        if (request.method === 'POST') return await this.postSignal(request, ipKey);
        if (request.method === 'GET') return await this.getSignals(url);
        if (request.method === 'DELETE') return await this.deleteSignals(url);
      }
      if (url.pathname === '/api/peers') {
        if (request.method === 'POST') return await this.registerPeer(request, ipKey);
        if (request.method === 'GET') return await this.getPeers(url);
      }
      if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();
      return json({ code: 404, message: 'Not found', next_step: 'Check the endpoint path.' }, 404);
    } catch (err) {
      console.error(`[hub] error ${url.pathname}: ${(err as Error).message}`);
      return json({ code: 503, message: 'Relay temporarily unavailable.', details: { reason: 'storage_unavailable', retry_after_ms: 5000 }, next_step: 'Wait five seconds before retrying.' }, 503, { 'Retry-After': '5' });
    }
  }

  // ---- Presence -------------------------------------------------------

  private async registerPeer(request: Request, ipKey: string): Promise<Response> {
    const invalid = async (status: number, message: string): Promise<Response> => {
      const d = this.protection.failures(ipKey, true);
      if (d.reason !== 'allowed') return reject429(d.retryAfterMs, d.cooldownUntil, d.reason);
      return json({ code: status, message, details: {}, next_step: 'Correct the envelope and signature before retrying.' }, status);
    };

    const body = (await request.json().catch(() => null)) as Partial<PeerRecord> | null;
    const wallet = body?.wallet?.toLowerCase()?.trim();
    if (!body || !wallet || !ADDRESS_REGEX.test(wallet)) return invalid(400, 'Invalid wallet address');
    const normalized = normalizeAddress(wallet);
    if (!normalized) return invalid(400, 'Invalid wallet checksum');

    if (await this.banlist.isBanned(normalized)) {
      this.peers.delete(normalized);
      await this.persistPeers();
      return json({ code: 403, message: 'Wallet is banned from the network' }, 403);
    }

    if (!body.peerId || !body.chainId || !isRecentTimestamp(body.timestamp || 0)) {
      return invalid(400, 'Missing or invalid peerId, chainId or timestamp');
    }

    const messageToSign = JSON.stringify({
      wallet: normalized, peerId: body.peerId, chainId: body.chainId,
      multiaddrs: body.multiaddrs, timestamp: body.timestamp,
    });
    if (isSignatureRequired(this.env) && !body.signature) return invalid(401, 'Signature required');
    if (body.signature && !(await verifyRequestSignature(normalized, messageToSign, body.signature))) {
      return invalid(403, 'Invalid signature');
    }

    const peer: PeerRecord = {
      wallet: normalized,
      peerId: body.peerId,
      chainId: Number(body.chainId) || 1,
      multiaddrs: body.multiaddrs?.slice(0, 8) ?? [],
      timestamp: Number(body.timestamp) || Date.now(),
      lastSeen: Date.now(),
      signature: body.signature,
    };
    this.peers.set(normalized, peer);
    await this.persistPeers();
    console.log(`[hub] peer registered wallet:${normalized.slice(0, 10)}… peers:${this.peers.size}`);
    return json({ code: 200, message: 'Peer registered', data: peer, next_step: 'Poll /api/peers or exchange signaling messages via /api/signal' });
  }

  private async getPeers(url: URL): Promise<Response> {
    const now = Date.now();
    const online = [...this.peers.values()].filter((p) => now - p.lastSeen <= PEER_TTL_MS);

    const wallet = url.searchParams.get('wallet')?.toLowerCase().trim();
    if (wallet) {
      if (!ADDRESS_REGEX.test(wallet)) return json({ code: 400, message: 'Invalid wallet address' }, 400);
      const addr = normalizeAddress(wallet)!;
      const record = (await this.banlist.isBanned(addr)) ? null : online.find((p) => p.wallet === addr) ?? null;
      return json({
        code: 200,
        message: record ? 'Peer found' : 'Peer not found or offline',
        data: record,
        next_step: record ? 'Use peer data to dial or send signal' : 'Register and retry later',
      });
    }

    const peerId = url.searchParams.get('peerId');
    const record = peerId ? online.find((p) => p.peerId === peerId) ?? null : null;
    if (peerId) {
      return json({
        code: 200,
        message: record ? 'Peer found' : 'Peer not found or offline',
        data: record,
        next_step: record ? 'Use peer data to dial or send signal' : 'Register and retry later',
      });
    }

    const visible: PeerRecord[] = [];
    for (const peer of online) {
      if (await this.banlist.isBanned(peer.wallet)) continue;
      visible.push(peer);
    }
    return json({ code: 200, message: 'Online peers listed', data: visible, next_step: 'Use peer data to dial or send signal' });
  }

  // ---- Signaling ------------------------------------------------------

  private async postSignal(request: Request, ipKey: string): Promise<Response> {
    const invalid = async (status: number, message: string): Promise<Response> => {
      const d = this.protection.failures(ipKey, true);
      if (d.reason !== 'allowed') return reject429(d.retryAfterMs, d.cooldownUntil, d.reason);
      return json({ code: status, message, details: {}, next_step: 'Correct the envelope and signature before retrying.' }, status);
    };

    const body = (await request.json().catch(() => null)) as Partial<SignalEnvelope> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid(400, 'Invalid signal envelope');

    const topic = body.topic?.trim();
    const type = body.type as SignalType;
    const from = body.from?.toLowerCase()?.trim();
    const to = body.to?.toLowerCase()?.trim();
    const timestamp = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? body.timestamp : 0;

    if (typeof body.topic !== 'string' || typeof from !== 'string' || (body.to !== undefined && typeof body.to !== 'string')) {
      return invalid(400, 'Invalid signal fields');
    }
    if (!topic || topic.length > 128) return invalid(400, 'Invalid or missing topic');
    if (!from || !ADDRESS_REGEX.test(from)) return invalid(400, 'Invalid sender wallet');
    if (to && !ADDRESS_REGEX.test(to)) return invalid(400, 'Invalid recipient wallet');
    if (!SIGNAL_TYPES.has(type)) return invalid(400, 'Invalid signal type');
    if (typeof body.payload !== 'string' || new TextEncoder().encode(body.payload).byteLength > MAX_PAYLOAD_LENGTH) {
      return invalid(400, 'Invalid or oversized payload');
    }
    if (!isRecentTimestamp(timestamp)) return invalid(400, 'Timestamp outside accepted window');

    const normalizedFrom = normalizeAddress(from);
    if (!normalizedFrom) return invalid(400, 'Invalid sender checksum');
    const normalizedTo = (to ? normalizeAddress(to) : undefined) ?? undefined;
    if (to && !normalizedTo) return invalid(400, 'Invalid recipient checksum');

    if (await this.banlist.isBanned(normalizedFrom)) {
      return json({ code: 403, message: 'Sender wallet is banned from the network', details: {}, next_step: 'Review network access policy.' }, 403);
    }
    if (normalizedTo && (await this.banlist.isBanned(normalizedTo))) {
      return json({ code: 403, message: 'Recipient wallet is banned from the network', details: {}, next_step: 'Review network access policy.' }, 403);
    }

    const messageToSign = JSON.stringify({ topic, type, payload: body.payload, from, to, timestamp });
    if (isSignatureRequired(this.env) && !body.signature) return invalid(401, 'Signature required');
    if (body.signature && !(await verifyRequestSignature(normalizedFrom, messageToSign, body.signature))) {
      return invalid(403, 'Invalid signature');
    }

    const paceKey = await digest(body.signature ? `wallet:${normalizedFrom.toLowerCase()}` : `ip:${ipKey}`);
    const pace = this.protection.checkClient(paceKey);
    if (pace.reason !== 'allowed') return reject429(pace.retryAfterMs, pace.cooldownUntil, pace.reason);

    const envelope: SignalEnvelope = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      topic,
      type,
      payload: body.payload,
      from: normalizedFrom,
      to: normalizedTo,
      timestamp,
      signature: body.signature,
    };

    await this.loadTopic(topic);
    const list = this.signals.get(topic)!;
    list.push(envelope);
    if (list.length > MAX_SIGNALS_PER_TOPIC) list.splice(0, list.length - MAX_SIGNALS_PER_TOPIC);
    await this.persistTopic(topic);

    this.broadcast(envelope);
    console.log(`[hub] signal stored - topic:${topic} type:${type} from:${normalizedFrom.slice(0, 10)}… id:${envelope.id}`);
    return json({ code: 200, message: 'Signal stored', data: envelope, next_step: 'Recipient should poll GET /api/signal?topic=<topic>&since=<id>&to=<wallet>' });
  }

  private async getSignals(url: URL): Promise<Response> {
    const topic = url.searchParams.get('topic');
    const since = url.searchParams.get('since') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    if (!topic) return json({ code: 400, message: 'Missing topic', details: {}, next_step: 'Correct the envelope and signature before retrying.' }, 400);

    let normalizedTo: string | undefined;
    if (to) {
      const cleaned = to.toLowerCase().trim();
      if (!ADDRESS_REGEX.test(cleaned)) return json({ code: 400, message: 'Invalid recipient wallet', details: {}, next_step: 'Correct the envelope and signature before retrying.' }, 400);
      const parsed = normalizeAddress(cleaned);
      if (!parsed) return json({ code: 400, message: 'Invalid recipient checksum', details: {}, next_step: 'Correct the envelope and signature before retrying.' }, 400);
      normalizedTo = parsed;
      if (await this.banlist.isBanned(normalizedTo)) {
        return json({ code: 403, message: 'Recipient wallet is banned from the network', details: {}, next_step: 'Review network access policy.' }, 403);
      }
    }

    await this.loadTopic(topic);
    const now = Date.now();
    const messages = (this.signals.get(topic) ?? []).filter((s) => {
      if (now - s.timestamp > SIGNAL_TTL_MS) return false;
      if (since && s.id <= since) return false;
      if (normalizedTo && s.to && s.to.toLowerCase() !== normalizedTo.toLowerCase()) return false;
      return true;
    });
    return json({ code: 200, message: 'Signals retrieved', data: messages, next_step: messages.length ? 'Process signals and re-poll for more' : 'Keep polling periodically' });
  }

  private async deleteSignals(url: URL): Promise<Response> {
    const topic = url.searchParams.get('topic');
    const beforeId = url.searchParams.get('beforeId');
    if (!topic) return json({ code: 400, message: 'Missing topic', details: {}, next_step: 'Correct the envelope and signature before retrying.' }, 400);
    if (!beforeId) return json({ code: 400, message: 'Missing beforeId', details: {}, next_step: 'Correct the envelope and signature before retrying.' }, 400);

    await this.loadTopic(topic);
    const list = this.signals.get(topic) ?? [];
    const remaining = list.filter((s) => s.id > beforeId);
    const trimmed = list.length - remaining.length;
    if (trimmed > 0) {
      this.signals.set(topic, remaining);
      await this.persistTopic(topic);
    }
    return json({ code: 200, message: 'Signals trimmed', data: { trimmed }, next_step: 'Continue polling with the same since parameter' });
  }

  // ---- WebSocket push --------------------------------------------------

  private handleWebSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ code: 400, message: 'Expected WebSocket upgrade' }, 400);
    const topics = (url.searchParams.get('topics') ?? '').split(',').map((t) => t.trim()).filter((t) => t && t.length <= 128).slice(0, 16);
    const wallet = url.searchParams.get('wallet')?.toLowerCase().trim();
    const normalizedWallet = wallet && ADDRESS_REGEX.test(wallet) ? normalizeAddress(wallet) ?? undefined : undefined;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SessionAttachment = { wallet: normalizedWallet, topics };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, topics.map((t) => `topic:${t}`));
    console.log(`[hub] ws connected topics:${topics.length} wallet:${normalizedWallet?.slice(0, 10) ?? 'anon'}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Signaling flows over POST /api/signal; messages here are reserved
    // for future subscription management (subscribe/unsubscribe topics).
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(1000, 'closed'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }

  private broadcast(envelope: SignalEnvelope): void {
    const topicSockets = this.ctx.getWebSockets(`topic:${envelope.topic}`);
    for (const ws of topicSockets) {
      const meta = ws.deserializeAttachment() as SessionAttachment | null;
      if (!meta) continue;
      if (envelope.to && meta.wallet && envelope.to.toLowerCase() !== meta.wallet.toLowerCase()) continue;
      try { ws.send(JSON.stringify(envelope)); } catch { /* socket closing */ }
    }
  }

  // ---- Status & housekeeping ------------------------------------------

  private getStatus(): Response {
    const now = Date.now();
    return json({
      code: 200,
      message: 'Relay operational',
      data: {
        status: 'available',
        services: { durable_object: 'available', redis: 'not_configured' },
        peers_online: [...this.peers.values()].filter((p) => now - p.lastSeen <= PEER_TTL_MS).length,
        topics_active: this.signals.size,
        checked_at: new Date(now).toISOString(),
        retry_after_ms: 60_000,
      },
      next_step: 'Use /api/signal, /api/peers or /ws',
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let peersChanged = false;
    for (const [wallet, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TTL_MS * 2) { this.peers.delete(wallet); peersChanged = true; }
    }
    if (peersChanged) await this.persistPeers();
    for (const [topic, list] of this.signals) {
      const fresh = list.filter((s) => now - s.timestamp <= SIGNAL_TTL_MS);
      if (fresh.length !== list.length) {
        this.signals.set(topic, fresh);
        await this.persistTopic(topic);
      }
      if (fresh.length === 0) {
        this.signals.delete(topic);
        this.loadedTopics.delete(topic);
        await this.ctx.storage.delete(`topic:${topic}`);
      }
    }
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    const next = (await this.ctx.storage.getAlarm()) ?? 0;
    if (next <= Date.now()) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  private async loadTopic(topic: string): Promise<void> {
    if (this.loadedTopics.has(topic)) return;
    this.loadedTopics.add(topic);
    const stored = await this.ctx.storage.get<SignalEnvelope[]>(`topic:${topic}`);
    this.signals.set(topic, stored ?? []);
  }

  private async persistTopic(topic: string): Promise<void> {
    await this.ctx.storage.put(`topic:${topic}`, this.signals.get(topic) ?? []);
  }

  private async persistPeers(): Promise<void> {
    await this.ctx.storage.put('peers', Object.fromEntries(this.peers));
  }
}
