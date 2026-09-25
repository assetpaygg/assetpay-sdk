import type { HttpClient, RequestOptions } from '../internal/http.js';
import type { Inventory, InventoryQuery, MerchantInventoryQuery } from '../types/api.js';

export class InventoryModule {
  constructor(private readonly http: HttpClient) {}

  get(query: MerchantInventoryQuery, opts?: RequestOptions): Promise<Inventory> {
    return this.http.send({ method: 'GET', path: '/secure/inventory', query, retry: 'safe' }, opts);
  }
}

export class ClientInventoryModule {
  constructor(private readonly http: HttpClient) {}

  get(query: InventoryQuery = {}, opts?: RequestOptions): Promise<Inventory> {
    return this.http.send({ method: 'GET', path: '/client/inventory', query, retry: 'safe' }, opts);
  }
}
