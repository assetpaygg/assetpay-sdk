import { randomUUID } from 'node:crypto';
import { invalidInput } from '../errors.js';
import type { HttpClient, RequestOptions } from '../internal/http.js';
import { paginate } from '../internal/util.js';
import type {
  CryptoDeposit,
  CryptoDepositAddress,
  CryptoDepositAddressQuery,
  CryptoDepositPage,
  CryptoListQuery,
  CryptoWithdrawal,
  CryptoWithdrawalPage,
  CryptoWithdrawInput,
  MerchantCryptoDepositAddressQuery,
  MerchantCryptoListQuery,
  MerchantCryptoWithdrawInput,
} from '../types/api.js';

const WITHDRAW_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

function withRequestId<T extends CryptoWithdrawInput>(input: T): T & { requestId: string } {
  const requestId = input.requestId ?? randomUUID();
  if (!WITHDRAW_REQUEST_ID.test(requestId)) {
    throw invalidInput({ requestId: 'must be 8-64 characters of A-Z, a-z, 0-9, _ or -' });
  }
  return { ...input, requestId };
}

class CryptoRoutes<A extends object, L extends CryptoListQuery, W extends CryptoWithdrawInput> {
  constructor(
    protected readonly http: HttpClient,
    private readonly base: '/secure/crypto' | '/client/crypto',
  ) {}

  depositAddress(query: A, opts?: RequestOptions): Promise<CryptoDepositAddress> {
    return this.http.send(
      { method: 'GET', path: `${this.base}/deposit-address`, query, retry: 'safe' },
      opts,
    );
  }

  deposits(query: L, opts?: RequestOptions): Promise<CryptoDepositPage> {
    return this.http.send(
      { method: 'GET', path: `${this.base}/deposits`, query, retry: 'safe' },
      opts,
    );
  }

  iterateDeposits(query: Omit<L, 'before'>, opts?: RequestOptions): AsyncGenerator<CryptoDeposit> {
    return paginate(
      (before) => this.deposits({ ...query, before } as L, opts),
      (page) => page.deposits,
      (page) => page.nextBefore,
    );
  }

  withdrawals(query: L, opts?: RequestOptions): Promise<CryptoWithdrawalPage> {
    return this.http.send(
      { method: 'GET', path: `${this.base}/withdrawals`, query, retry: 'safe' },
      opts,
    );
  }

  iterateWithdrawals(
    query: Omit<L, 'before'>,
    opts?: RequestOptions,
  ): AsyncGenerator<CryptoWithdrawal> {
    return paginate(
      (before) => this.withdrawals({ ...query, before } as L, opts),
      (page) => page.withdrawals,
      (page) => page.nextBefore,
    );
  }

  async withdraw(input: W, opts?: RequestOptions): Promise<CryptoWithdrawal> {
    return this.http.send(
      {
        method: 'POST',
        path: `${this.base}/withdraw`,
        body: withRequestId(input),
        retry: 'idempotent',
      },
      opts,
    );
  }
}

export class CryptoModule extends CryptoRoutes<
  MerchantCryptoDepositAddressQuery,
  MerchantCryptoListQuery,
  MerchantCryptoWithdrawInput
> {
  constructor(http: HttpClient) {
    super(http, '/secure/crypto');
  }
}

export class ClientCryptoModule extends CryptoRoutes<
  CryptoDepositAddressQuery,
  CryptoListQuery,
  CryptoWithdrawInput
> {
  constructor(http: HttpClient) {
    super(http, '/client/crypto');
  }

  override deposits(
    query: CryptoListQuery = {},
    opts?: RequestOptions,
  ): Promise<CryptoDepositPage> {
    return super.deposits(query, opts);
  }

  override iterateDeposits(
    query: Omit<CryptoListQuery, 'before'> = {},
    opts?: RequestOptions,
  ): AsyncGenerator<CryptoDeposit> {
    return super.iterateDeposits(query, opts);
  }

  override withdrawals(
    query: CryptoListQuery = {},
    opts?: RequestOptions,
  ): Promise<CryptoWithdrawalPage> {
    return super.withdrawals(query, opts);
  }

  override iterateWithdrawals(
    query: Omit<CryptoListQuery, 'before'> = {},
    opts?: RequestOptions,
  ): AsyncGenerator<CryptoWithdrawal> {
    return super.iterateWithdrawals(query, opts);
  }
}
