import { EventEmitter } from 'node:events';
import { DEFAULT_BASE_URL } from './internal/urls.js';
import { SDK_VERSION } from './internal/version.js';
import type { FundingStatus, GameId, Item, MarketSource, Trade } from './types/api.js';

export type RealtimeFailure = 'missing_peer' | 'auth_failed' | 'connect_failed';

export class AssetPayRealtimeError extends Error {
  override readonly name = 'AssetPayRealtimeError';

  constructor(
    readonly reason: RealtimeFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface DepositEvent {
  id: string;
  merchantId: string | null;
  status: FundingStatus;
  amounts: { usd: string; token: string };
  asset: { token: string; chain: string; exchangeRateUsdPerToken: string };
  address: string | null;
  txnHash: string | null;
  creditedUsd: string;
  overpaymentUsd: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type MarketEvent =
  | { type: 'upsert' | 'patch'; game: GameId; source: MarketSource; item: Item; at?: string }
  | { type: 'remove'; game: GameId; source: MarketSource; itemId: string }
  | { type: 'sync'; reason: 'feed'; game: GameId; source: MarketSource }
  | { type: 'sync'; reason: 'subscribe' };

export interface RealtimeEvents {
  connect: [];
  disconnect: [reason: string];
  error: [error: AssetPayRealtimeError];
  trade: [trade: Trade];
  deposit: [deposit: DepositEvent];
  market: [event: MarketEvent];
}

export interface RealtimeOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  authWindowMs?: number | undefined;
  authRetryMs?: number | undefined;
  userAgent?: string | undefined;
}

interface IoSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
}

type IoFactory = (uri: string, opts: Record<string, unknown>) => IoSocket;

const MAX_AUTH_RETRY_MS = 300_000;

async function loadIo(): Promise<IoFactory> {
  try {
    const mod = await import('socket.io-client');
    return mod.io as unknown as IoFactory;
  } catch (err) {
    throw new AssetPayRealtimeError(
      'missing_peer',
      '@assetpay/assetpay-sdk/realtime needs socket.io-client: install socket.io-client@^4.8',
      { cause: err },
    );
  }
}

export class AssetPayRealtime extends EventEmitter<RealtimeEvents> {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly authWindowMs: number;
  private readonly authRetryMs: number;
  private readonly userAgent: string;
  private socket: IoSocket | undefined;
  private closed = false;
  private connectedAt = 0;
  private heard = false;
  private authFailures = 0;
  private authTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private startup: { resolve(): void; reject(error: AssetPayRealtimeError): void } | undefined;

  constructor(options: RealtimeOptions) {
    super();
    if (!options?.apiKey) throw new TypeError('apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.authWindowMs = options.authWindowMs ?? 1_500;
    this.authRetryMs = options.authRetryMs ?? 30_000;
    const base = `assetpay-sdk/${SDK_VERSION} node/${process.versions.node}`;
    this.userAgent = options.userAgent ? `${base} ${options.userAgent}` : base;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  async connect(): Promise<void> {
    if (this.socket || this.closed) throw new Error('connect() can only be called once');
    const io = await loadIo();
    if (this.closed) return;
    const settled = new Promise<void>((resolve, reject) => {
      this.startup = { resolve, reject };
    });
    const socket = io(this.baseUrl, {
      transports: ['websocket'],
      query: { apiKey: this.apiKey },
      extraHeaders: { 'user-agent': this.userAgent },
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });
    this.socket = socket;
    this.wire(socket);
    return settled;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    clearTimeout(this.retryTimer);
    this.socket?.disconnect();
    this.settle(new AssetPayRealtimeError('connect_failed', 'Closed before the feed was up'));
  }

  private wire(socket: IoSocket): void {
    socket.on('connect', () => {
      this.connectedAt = Date.now();
      this.heard = false;
      this.emit('connect');
      clearTimeout(this.authTimer);
      this.authTimer = setTimeout(() => {
        if (socket.connected) this.accepted();
      }, this.authWindowMs);
    });

    socket.on('disconnect', (reason: string) => {
      clearTimeout(this.authTimer);
      this.emit('disconnect', reason);
      if (this.closed || reason !== 'io server disconnect') return;
      // The server authenticates after the socket opens and answers a bad key with a bare
      // disconnect, so a drop inside the window with nothing received is the only auth signal.
      if (!this.heard && Date.now() - this.connectedAt < this.authWindowMs) {
        const error = new AssetPayRealtimeError(
          'auth_failed',
          'The server closed the feed as it opened: check the API key is valid, not revoked, and allowed from this IP',
        );
        if (this.startup) {
          this.settle(error);
          this.close();
          return;
        }
        this.report(error);
        this.reconnect(Math.min(MAX_AUTH_RETRY_MS, this.authRetryMs * 2 ** this.authFailures++));
        return;
      }
      this.reconnect(250 + Math.floor(Math.random() * 1_000));
    });

    socket.on('connect_error', (err: Error) => {
      const error = new AssetPayRealtimeError('connect_failed', err.message, { cause: err });
      if (this.startup) {
        this.settle(error);
        this.close();
        return;
      }
      this.report(error);
    });

    socket.on('trade', (payload: { trade?: Trade } | undefined) => {
      this.heard = true;
      this.accepted();
      if (payload?.trade) this.emit('trade', payload.trade);
    });

    socket.on('deposit', (payload: { funding?: DepositEvent } | undefined) => {
      this.heard = true;
      this.accepted();
      if (payload?.funding) this.emit('deposit', payload.funding);
    });

    socket.on('market', (payload: MarketEvent | undefined) => {
      this.heard = true;
      this.accepted();
      if (payload?.type) this.emit('market', payload);
    });
  }

  private accepted(): void {
    clearTimeout(this.authTimer);
    this.authFailures = 0;
    this.settle();
  }

  private settle(error?: AssetPayRealtimeError): void {
    const startup = this.startup;
    if (!startup) return;
    this.startup = undefined;
    if (error) startup.reject(error);
    else startup.resolve();
  }

  private reconnect(delayMs: number): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.closed) this.socket?.connect();
    }, delayMs);
  }

  // An unhandled 'error' event throws; a feed hiccup must never take the merchant's process down.
  private report(error: AssetPayRealtimeError): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }
}
