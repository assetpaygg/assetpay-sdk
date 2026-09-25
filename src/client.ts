import type { Dispatcher } from 'undici';
import { invalidInput } from './errors.js';
import {
  type Auth,
  createDispatcher,
  defaultUserAgent,
  HttpClient,
  type HttpEvent,
  type RequestOptions,
} from './internal/http.js';
import { ClientSession, decodeClientToken, mintClientToken } from './internal/token.js';
import { DEFAULT_BASE_URL, STAGING_BASE_URL } from './internal/urls.js';
import { ClientsModule } from './modules/clients.js';
import { CryptoModule } from './modules/crypto.js';
import { InventoryModule } from './modules/inventory.js';
import { MarketModule } from './modules/market.js';
import { RawModule } from './modules/raw.js';
import { ScopedClient } from './modules/scoped.js';
import { type Reconciler, TradesModule } from './modules/trades.js';
import { WalletModule } from './modules/wallet.js';
import type { ClientIdentity, HealthStatus } from './types/api.js';
import type { WebhookEvent } from './types/webhooks.js';
import { type HeaderSource, type RawBody, verifyWebhook } from './webhooks.js';

export { DEFAULT_BASE_URL, STAGING_BASE_URL };

export interface AssetPayOptions {
  apiKey: string;
  apiSecret?: string | undefined;
  merchantId?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  maxRetryWaitMs?: number | undefined;
  proxy?: string | undefined;
  dispatcher?: Dispatcher | undefined;
  userAgent?: string | undefined;
  debug?: ((event: HttpEvent) => void) | undefined;
  reconcile?: boolean | undefined;
}

export interface WebhookVerifyOptions {
  toleranceSeconds?: number | undefined;
  now?: Date | number | undefined;
  secret?: string | readonly string[] | undefined;
}

export class AssetPay {
  readonly clients: ClientsModule;
  readonly market: MarketModule;
  readonly inventory: InventoryModule;
  readonly trades: TradesModule;
  readonly crypto: CryptoModule;
  readonly wallet: WalletModule;
  readonly raw: RawModule;

  private readonly http: HttpClient;
  private readonly apiSecret: string | undefined;
  private merchantId: string | undefined;
  private readonly ownsDispatcher: boolean;
  private readonly reconciler: Reconciler;

  constructor(options: AssetPayOptions) {
    if (!options?.apiKey) throw invalidInput({ apiKey: 'is required' });
    this.apiSecret = options.apiSecret || undefined;
    this.merchantId = options.merchantId || undefined;
    this.ownsDispatcher = options.dispatcher === undefined;
    const apiKey = options.apiKey;
    const userAgent = options.userAgent
      ? `${defaultUserAgent()} ${options.userAgent}`
      : defaultUserAgent();

    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      auth: { headers: () => ({ 'api-key': apiKey }) },
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      maxRetryWaitMs: options.maxRetryWaitMs ?? 5_000,
      dispatcher: options.dispatcher ?? createDispatcher({ proxy: options.proxy }),
      userAgent,
      debug: options.debug,
    });

    this.reconciler = {
      enabled: options.reconcile ?? false,
      lookup: (externalId, opts) => this.trades.get(externalId, opts),
    };

    this.clients = new ClientsModule(this.http);
    this.market = new MarketModule(this.http);
    this.inventory = new InventoryModule(this.http);
    this.trades = new TradesModule(this.http, this.reconciler);
    this.crypto = new CryptoModule(this.http);
    this.wallet = new WalletModule(this.http);
    this.raw = new RawModule(this.http);
  }

  asClient(identity: ClientIdentity): ScopedClient {
    const session = new ClientSession(() => this.issueClientToken(identity));
    return new ScopedClient(this.http.withAuth(session), session, this.reconciler);
  }

  withClientToken(token: string): ScopedClient {
    decodeClientToken(token);
    const session = new ClientSession(undefined, token);
    return new ScopedClient(this.http.withAuth(session), session, this.reconciler);
  }

  async mintClientToken(identity: ClientIdentity): Promise<string> {
    return this.issueClientToken(identity);
  }

  health(opts?: RequestOptions): Promise<HealthStatus> {
    const anonymous: Auth = { headers: () => ({}) };
    return this.http
      .withAuth(anonymous)
      .send({ method: 'GET', path: '/health', retry: 'safe' }, opts);
  }

  verifyWebhook(
    rawBody: RawBody,
    headers: HeaderSource,
    opts: WebhookVerifyOptions = {},
  ): WebhookEvent {
    const secret = opts.secret ?? this.apiSecret;
    if (!secret) throw invalidInput({ apiSecret: 'is required to verify webhooks' });
    return verifyWebhook(rawBody, headers, { ...opts, secret });
  }

  async close(): Promise<void> {
    if (this.ownsDispatcher) await this.http.config.dispatcher.close();
  }

  private async issueClientToken(identity: ClientIdentity): Promise<string> {
    if (this.apiSecret && this.merchantId) {
      return mintClientToken(identity, { apiSecret: this.apiSecret, merchantId: this.merchantId });
    }
    const { token } = await this.clients.authenticate(identity);
    if (this.apiSecret && !this.merchantId) {
      const { header, claims } = decodeClientToken(token);
      this.merchantId = claims.merchantId ?? header.userId;
    }
    return token;
  }
}
