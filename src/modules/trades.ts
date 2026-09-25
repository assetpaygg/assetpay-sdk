import { isAmbiguous, isError } from '../errors.js';
import type { HttpClient, RequestOptions } from '../internal/http.js';
import { checkExternalId, paginate, segment, withBodyGame } from '../internal/util.js';
import { attachMeta, meta } from '../meta.js';
import type {
  BuyInput,
  DepositInput,
  DepositTrade,
  ItemCancelResult,
  QuickBuyInput,
  QuickWithdrawInput,
  SellInput,
  Trade,
  TradeCancelResult,
  TradeListQuery,
  TradePage,
  WithdrawInput,
} from '../types/api.js';

const DEPOSIT_TIMEOUT_MS = 100_000;
const MAX_REFS_PER_REQUEST = 100;

export interface WriteOptions extends RequestOptions {
  reconcile?: boolean | undefined;
}

export interface Reconciler {
  enabled: boolean;
  lookup(externalId: string, opts?: RequestOptions): Promise<Trade>;
}

function reconciledAs<T>(value: T, how: 'resent' | 'found'): T {
  const info = meta(value);
  return info ? attachMeta(value, { ...info, reconciled: how }) : value;
}

// The (merchant, externalId) unique index makes the resend safe: if the first attempt landed,
// the second is refused with EXTERNAL_ID_EXISTS instead of creating another trade.
async function reconciled<T extends Trade>(
  reconciler: Reconciler,
  externalId: string | undefined,
  opts: WriteOptions | undefined,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    const enabled = opts?.reconcile ?? reconciler.enabled;
    if (!enabled || !externalId || !isAmbiguous(err) || opts?.signal?.aborted) throw err;
    try {
      return reconciledAs(await write(), 'resent');
    } catch {
      if (opts?.signal?.aborted) throw err;
      const found = await reconciler
        .lookup(externalId, { signal: opts?.signal })
        .catch(() => undefined);
      if (found) return reconciledAs(found as T, 'found');
      throw err;
    }
  }
}

type WithdrawLike = {
  externalId?: string | undefined;
  items: { externalId?: string | undefined }[];
};

function checkWithdraw(input: WithdrawLike): void {
  checkExternalId(input.externalId);
  input.items.forEach((item, i) => {
    checkExternalId(item.externalId, `items.${i}.externalId`);
  });
}

function checkQuick(input: QuickWithdrawInput): void {
  checkExternalId(input.externalId);
  input.externalIds?.forEach((id, i) => {
    checkExternalId(id, `externalIds.${i}`);
  });
}

abstract class TradeHistory {
  protected abstract readonly base: '/secure' | '/client';

  constructor(protected readonly http: HttpClient) {}

  list(query: TradeListQuery = {}, opts?: RequestOptions): Promise<TradePage> {
    return this.http.send(
      { method: 'GET', path: `${this.base}/trades`, query, retry: 'safe' },
      opts,
    );
  }

  iterate(
    query: Omit<TradeListQuery, 'cursor'> = {},
    opts?: RequestOptions,
  ): AsyncGenerator<Trade> {
    return paginate(
      (cursor) => this.list({ ...query, cursor }, opts),
      (page) => page.items,
      (page) => page.nextCursor,
    );
  }
}

export class TradesModule extends TradeHistory {
  protected readonly base = '/secure' as const;

  constructor(
    http: HttpClient,
    private readonly reconciler: Reconciler,
  ) {
    super(http);
  }

  async get(ref: string, opts?: RequestOptions): Promise<Trade> {
    if (ref.includes(',')) throw new TypeError('trades.get takes one ref; use trades.getMany');
    return this.http.send(
      { method: 'GET', path: `/secure/trades/${segment(ref, 'ref')}`, retry: 'safe' },
      opts,
    );
  }

  async getMany(refs: readonly string[], opts?: RequestOptions): Promise<Trade[]> {
    const unique = [...new Set(refs.map((ref) => ref.trim()))];
    unique.forEach((ref, i) => {
      checkExternalId(ref, `refs.${i}`);
    });
    const out: Trade[] = [];
    for (let i = 0; i < unique.length; i += MAX_REFS_PER_REQUEST) {
      const chunk = unique.slice(i, i + MAX_REFS_PER_REQUEST);
      if (chunk.length === 1) {
        try {
          out.push(await this.get(chunk[0]!, opts));
        } catch (err) {
          if (!isError(err, 'TRADE_NOT_FOUND')) throw err;
        }
        continue;
      }
      const path = `/secure/trades/${chunk.map((ref) => encodeURIComponent(ref)).join(',')}`;
      out.push(...(await this.http.send<Trade[]>({ method: 'GET', path, retry: 'safe' }, opts)));
    }
    return out;
  }

  async sell(input: SellInput, opts?: WriteOptions): Promise<DepositTrade> {
    checkExternalId(input.externalId);
    return reconciled(this.reconciler, input.externalId, opts, () =>
      this.http.send(
        {
          method: 'POST',
          path: '/secure/sell',
          body: withBodyGame(input),
          retry: 'ambiguous',
          timeoutMs: DEPOSIT_TIMEOUT_MS,
        },
        opts,
      ),
    );
  }

  async buy(input: BuyInput, opts?: WriteOptions): Promise<Trade> {
    checkWithdraw(input);
    return reconciled(this.reconciler, input.externalId, opts, () =>
      this.http.send(
        { method: 'POST', path: '/secure/buy', body: withBodyGame(input), retry: 'ambiguous' },
        opts,
      ),
    );
  }

  async quickBuy(input: QuickBuyInput, opts?: WriteOptions): Promise<Trade> {
    checkQuick(input);
    return reconciled(this.reconciler, input.externalId, opts, () =>
      this.http.send(
        {
          method: 'POST',
          path: '/secure/buy/quick',
          body: withBodyGame(input),
          retry: 'ambiguous',
        },
        opts,
      ),
    );
  }

  async cancel(tradeId: string, opts?: RequestOptions): Promise<TradeCancelResult> {
    return this.http.send(
      {
        method: 'POST',
        path: `/secure/buy/${segment(tradeId, 'tradeId')}/cancel`,
        retry: 'repeatable',
      },
      opts,
    );
  }

  async cancelItem(
    tradeId: string,
    itemId: string,
    opts?: RequestOptions,
  ): Promise<ItemCancelResult> {
    return this.http.send(
      {
        method: 'POST',
        path: `/secure/buy/${segment(tradeId, 'tradeId')}/items/${segment(itemId, 'itemId')}/cancel`,
        retry: 'repeatable',
      },
      opts,
    );
  }
}

export class ClientTradesModule extends TradeHistory {
  protected readonly base = '/client' as const;

  constructor(
    http: HttpClient,
    private readonly reconciler: Reconciler,
  ) {
    super(http);
  }

  async deposit(input: DepositInput, opts?: WriteOptions): Promise<DepositTrade> {
    checkExternalId(input.externalId);
    return reconciled(this.reconciler, input.externalId, opts, () =>
      this.http.send(
        {
          method: 'POST',
          path: '/client/trading/deposit',
          body: withBodyGame(input),
          retry: 'ambiguous',
          timeoutMs: DEPOSIT_TIMEOUT_MS,
        },
        opts,
      ),
    );
  }

  async withdraw(input: WithdrawInput, opts?: WriteOptions): Promise<Trade> {
    checkWithdraw(input);
    return reconciled(this.reconciler, input.externalId, opts, () =>
      this.http.send(
        {
          method: 'POST',
          path: '/client/trading/withdraw',
          body: withBodyGame(input),
          retry: 'ambiguous',
        },
        opts,
      ),
    );
  }

  async quickWithdraw(input: QuickWithdrawInput, opts?: WriteOptions): Promise<Trade> {
    checkQuick(input);
    return reconciled(this.reconciler, input.externalId, opts, () =>
      this.http.send(
        {
          method: 'POST',
          path: '/client/trading/withdraw/quick',
          body: withBodyGame(input),
          retry: 'ambiguous',
        },
        opts,
      ),
    );
  }

  async cancel(tradeId: string, opts?: RequestOptions): Promise<TradeCancelResult> {
    return this.http.send(
      {
        method: 'POST',
        path: `/client/trading/withdraw/${segment(tradeId, 'tradeId')}/cancel`,
        retry: 'repeatable',
      },
      opts,
    );
  }

  async cancelItem(
    tradeId: string,
    itemId: string,
    opts?: RequestOptions,
  ): Promise<ItemCancelResult> {
    return this.http.send(
      {
        method: 'POST',
        path: `/client/trading/withdraw/${segment(tradeId, 'tradeId')}/items/${segment(itemId, 'itemId')}/cancel`,
        retry: 'repeatable',
      },
      opts,
    );
  }
}
