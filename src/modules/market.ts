import type { HttpClient, RequestOptions } from '../internal/http.js';
import type {
  Cs2PriceItem,
  Item,
  MarketListingsQuery,
  MarketPage,
  MarketSearchQuery,
  MarketSuggestions,
  MarketSuggestionsQuery,
  MerchantMarketSearchQuery,
  RustPriceItem,
} from '../types/api.js';

export class MarketModule {
  constructor(private readonly http: HttpClient) {}

  prices(query: { game: 252490 }, opts?: RequestOptions): Promise<RustPriceItem[]>;
  prices(query?: { game?: 730 }, opts?: RequestOptions): Promise<Cs2PriceItem[]>;
  prices(
    query: { game?: 730 | 252490 } = {},
    opts?: RequestOptions,
  ): Promise<Cs2PriceItem[] | RustPriceItem[]> {
    return this.http.send({ method: 'GET', path: '/secure/prices', query, retry: 'safe' }, opts);
  }

  search(query: MerchantMarketSearchQuery = {}, opts?: RequestOptions): Promise<MarketPage> {
    return this.http.send({ method: 'GET', path: '/secure/market', query, retry: 'safe' }, opts);
  }

  listings(query: MarketListingsQuery, opts?: RequestOptions): Promise<Item[]> {
    return this.http.send(
      { method: 'GET', path: '/secure/market/item', query, retry: 'safe' },
      opts,
    );
  }
}

export class ClientMarketModule {
  constructor(private readonly http: HttpClient) {}

  search(query: MarketSearchQuery = {}, opts?: RequestOptions): Promise<MarketPage> {
    return this.http.send({ method: 'GET', path: '/client/market', query, retry: 'safe' }, opts);
  }

  listings(query: MarketListingsQuery, opts?: RequestOptions): Promise<Item[]> {
    return this.http.send(
      { method: 'GET', path: '/client/market/item', query, retry: 'safe' },
      opts,
    );
  }

  suggestions(
    query: MarketSuggestionsQuery | string,
    opts?: RequestOptions,
  ): Promise<MarketSuggestions> {
    return this.http.send(
      {
        method: 'GET',
        path: '/client/market/suggestions',
        query: typeof query === 'string' ? { q: query } : query,
        retry: 'safe',
      },
      opts,
    );
  }
}
