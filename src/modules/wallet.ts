import type { HttpClient, RequestOptions } from '../internal/http.js';
import { segment } from '../internal/util.js';
import type {
  LedgerTransaction,
  LedgerTransactionDetails,
  LedgerTransactionPage,
  LedgerTransactionsQuery,
  WalletBalance,
} from '../types/api.js';

export class WalletModule {
  constructor(private readonly http: HttpClient) {}

  balance(opts?: RequestOptions): Promise<WalletBalance> {
    return this.http.send({ method: 'GET', path: '/v1/wallets/me/balance', retry: 'safe' }, opts);
  }

  transactions(
    query: LedgerTransactionsQuery = {},
    opts?: RequestOptions,
  ): Promise<LedgerTransactionPage> {
    return this.http.send(
      { method: 'GET', path: '/v1/ledger/transactions', query, retry: 'safe' },
      opts,
    );
  }

  async *iterateTransactions(
    query: Omit<LedgerTransactionsQuery, 'offset'> = {},
    opts?: RequestOptions,
  ): AsyncGenerator<LedgerTransaction> {
    let offset = 0;
    for (;;) {
      const page = await this.transactions({ ...query, offset }, opts);
      yield* page.items;
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.pagination.total) return;
    }
  }

  async transaction(id: string, opts?: RequestOptions): Promise<LedgerTransactionDetails> {
    return this.http.send(
      { method: 'GET', path: `/v1/ledger/transactions/${segment(id, 'id')}`, retry: 'safe' },
      opts,
    );
  }
}
