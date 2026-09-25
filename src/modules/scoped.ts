import type { HttpClient } from '../internal/http.js';
import type { ClientSession } from '../internal/token.js';
import { ClientCryptoModule } from './crypto.js';
import { ClientInventoryModule } from './inventory.js';
import { ClientMarketModule } from './market.js';
import { RawModule } from './raw.js';
import { ClientTradesModule, type Reconciler } from './trades.js';

export class ScopedClient {
  readonly inventory: ClientInventoryModule;
  readonly market: ClientMarketModule;
  readonly trades: ClientTradesModule;
  readonly crypto: ClientCryptoModule;
  readonly raw: RawModule;

  constructor(
    http: HttpClient,
    private readonly session: ClientSession,
    reconciler: Reconciler,
  ) {
    this.inventory = new ClientInventoryModule(http);
    this.market = new ClientMarketModule(http);
    this.trades = new ClientTradesModule(http, reconciler);
    this.crypto = new ClientCryptoModule(http);
    this.raw = new RawModule(http);
  }

  token(): Promise<string> {
    return this.session.token();
  }
}
