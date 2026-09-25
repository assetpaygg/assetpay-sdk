import type * as T from '../../src/types/index.js';
import type { paths } from './openapi.js';

type Method = 'get' | 'post';
type Op<P extends keyof paths, M extends Method> = NonNullable<paths[P][M]>;
type Success<O> = O extends { responses: infer R }
  ? R extends { 200: infer X }
    ? X
    : R extends { 201: infer X }
      ? X
      : never
  : never;
type Data<P extends keyof paths, M extends Method = 'get'> =
  Success<Op<P, M>> extends { content: { 'application/json': { data: infer D } } } ? D : never;
type Query<P extends keyof paths, M extends Method = 'get'> =
  Op<P, M> extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;
type Body<P extends keyof paths> =
  Op<P, 'post'> extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;

type Paths<X, P extends string = ''> = X extends readonly (infer U)[]
  ? Paths<U, `${P}[]`>
  : X extends object
    ? { [K in keyof X & string]-?: `${P}.${K}` | Paths<NonNullable<X[K]>, `${P}.${K}`> }[keyof X &
        string]
    : never;

type Widen<X> = X extends string
  ? string
  : X extends number
    ? number
    : X extends boolean
      ? boolean
      : X extends readonly (infer U)[]
        ? Widen<U>[]
        : X extends object
          ? { [K in keyof X]: Widen<X[K]> }
          : X;

type Drift<Spec, Sdk> =
  | `spec only: ${Exclude<Paths<Spec>, Paths<Sdk>>}`
  | `sdk only: ${Exclude<Paths<Sdk>, Paths<Spec>>}`;

type Mismatch<Spec, Sdk> = [Spec] extends [Widen<Sdk>] ? never : Spec;

type Verdict<Spec, Sdk, Shape> = [Spec] extends [never]
  ? 'spec operation not found'
  : [Drift<Spec, Sdk>] extends [never]
    ? [Shape] extends [never]
      ? true
      : Shape
    : Drift<Spec, Sdk>;

// A response shape can drift two ways: a field the spec gained that callers cannot see, or a
// field the SDK promises that the server no longer sends. Literal unions are widened because the
// SDK narrows free-form spec strings on purpose; the enum checks below guard those separately.
declare function response<Spec, Sdk>(check: Verdict<Spec, Sdk, Mismatch<Spec, Sdk>>): void;

// Inputs only need the key set: a parameter the server added, or one it dropped that the SDK
// still sends into a 400.
declare function input<Spec, Sdk>(check: Verdict<Spec, Sdk, never>): void;

response<Data<'/auth/authenticate-client', 'post'>, T.ClientAuthToken>(true);
response<Data<'/secure/check-tradeurl', 'post'>, T.TradeUrlCheck>(true);
response<Data<'/secure/prices'>, T.PriceItem[]>(true);
response<Data<'/secure/inventory'>, T.Inventory>(true);
response<Data<'/client/inventory'>, T.Inventory>(true);
response<Data<'/secure/sell', 'post'>, T.DepositTrade>(true);
response<Data<'/client/trading/deposit', 'post'>, T.DepositTrade>(true);
response<Data<'/secure/buy', 'post'>, T.Trade>(true);
response<Data<'/secure/buy/quick', 'post'>, T.Trade>(true);
response<Data<'/client/trading/withdraw', 'post'>, T.Trade>(true);
response<Data<'/client/trading/withdraw/quick', 'post'>, T.Trade>(true);
response<Data<'/secure/buy/{tradeId}/cancel', 'post'>, T.TradeCancelResult>(true);
response<Data<'/client/trading/withdraw/{tradeId}/cancel', 'post'>, T.TradeCancelResult>(true);
response<Data<'/secure/buy/{tradeId}/items/{itemId}/cancel', 'post'>, T.ItemCancelResult>(true);
response<
  Data<'/client/trading/withdraw/{tradeId}/items/{itemId}/cancel', 'post'>,
  T.ItemCancelResult
>(true);
response<Data<'/secure/market'>, T.MarketPage>(true);
response<Data<'/client/market'>, T.MarketPage>(true);
response<Data<'/secure/market/item'>, T.Item[]>(true);
response<Data<'/client/market/item'>, T.Item[]>(true);
response<Data<'/client/market/suggestions'>, T.MarketSuggestions>(true);
response<Data<'/secure/trades'>, T.TradePage>(true);
response<Data<'/client/trades'>, T.TradePage>(true);
response<Exclude<Data<'/secure/trades/{tradeId}'>, unknown[]>, T.Trade>(true);
response<Extract<Data<'/secure/trades/{tradeId}'>, unknown[]>, T.Trade[]>(true);
response<Data<'/secure/crypto/deposit-address'>, T.CryptoDepositAddress>(true);
response<Data<'/client/crypto/deposit-address'>, T.CryptoDepositAddress>(true);
response<Data<'/secure/crypto/deposits'>, T.CryptoDepositPage>(true);
response<Data<'/client/crypto/deposits'>, T.CryptoDepositPage>(true);
response<Data<'/secure/crypto/withdrawals'>, T.CryptoWithdrawalPage>(true);
response<Data<'/client/crypto/withdrawals'>, T.CryptoWithdrawalPage>(true);
response<Data<'/secure/crypto/withdraw', 'post'>, T.CryptoWithdrawal>(true);
response<Data<'/client/crypto/withdraw', 'post'>, T.CryptoWithdrawal>(true);
response<Data<'/v1/wallets/me/balance'>, T.WalletBalance>(true);
response<Data<'/v1/ledger/transactions'>, T.LedgerTransactionPage>(true);
response<Data<'/v1/ledger/transactions/{transactionId}'>, T.LedgerTransactionDetails>(true);

input<Query<'/secure/prices'>, T.PricesQuery>(true);
input<Query<'/secure/inventory'>, T.MerchantInventoryQuery>(true);
input<Query<'/client/inventory'>, T.InventoryQuery>(true);
input<Query<'/secure/market'>, T.MerchantMarketSearchQuery>(true);
input<Query<'/client/market'>, T.MarketSearchQuery>(true);
input<Query<'/secure/market/item'>, T.MarketListingsQuery>(true);
input<Query<'/client/market/item'>, T.MarketListingsQuery>(true);
input<Query<'/client/market/suggestions'>, T.MarketSuggestionsQuery>(true);
input<Query<'/secure/trades'>, T.TradeListQuery>(true);
input<Query<'/client/trades'>, T.TradeListQuery>(true);
input<Query<'/secure/crypto/deposit-address'>, T.MerchantCryptoDepositAddressQuery>(true);
input<Query<'/client/crypto/deposit-address'>, T.CryptoDepositAddressQuery>(true);
input<Query<'/secure/crypto/deposits'>, T.MerchantCryptoListQuery>(true);
input<Query<'/client/crypto/deposits'>, T.CryptoListQuery>(true);
input<Query<'/v1/ledger/transactions'>, T.LedgerTransactionsQuery>(true);
input<Body<'/secure/sell'>, T.SellInput>(true);
input<Body<'/client/trading/deposit'>, T.DepositInput>(true);
input<Body<'/secure/buy'>, T.BuyInput>(true);
input<Body<'/client/trading/withdraw'>, T.WithdrawInput>(true);
input<Body<'/secure/buy/quick'>, T.QuickBuyInput>(true);
input<Body<'/client/trading/withdraw/quick'>, T.QuickWithdrawInput>(true);
input<Body<'/secure/crypto/withdraw'>, T.MerchantCryptoWithdrawInput>(true);
input<Body<'/client/crypto/withdraw'>, T.CryptoWithdrawInput>(true);

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// The SDK narrows these to unions callers switch on exhaustively; a value the server starts
// sending that the union lacks would fall through every branch unseen.
declare function sameEnum<Spec, Sdk>(
  check: Equal<Spec, Sdk> extends true ? true : [Spec, Sdk],
): void;

type SpecTrade = Exclude<Data<'/secure/trades/{tradeId}'>, unknown[]>;
type SpecItem = SpecTrade['items'][number];
type SpecDeposit = Data<'/secure/crypto/deposits'>['deposits'][number];
type SpecWithdrawal = Data<'/secure/crypto/withdrawals'>['withdrawals'][number];
type SpecAddress = Data<'/secure/crypto/deposit-address'>;

sameEnum<SpecTrade['status'], T.TradeStatus>(true);
sameEnum<SpecTrade['type'], T.TradeType>(true);
sameEnum<SpecTrade['source'], T.TradeSource>(true);
sameEnum<NonNullable<SpecTrade['revertedBy']>, T.RevertedBy>(true);
sameEnum<NonNullable<SpecTrade['error']>, T.TradeErrorCode>(true);
sameEnum<NonNullable<SpecItem['status']>, T.TradeStatus>(true);
sameEnum<NonNullable<SpecItem['error']>, T.TradeFailureCode>(true);
sameEnum<NonNullable<NonNullable<SpecItem['offer']>['delivery']>, T.DeliveryMode>(true);
sameEnum<SpecDeposit['status'], T.CryptoDepositStatus>(true);
sameEnum<SpecWithdrawal['status'], T.CryptoWithdrawalStatus>(true);
sameEnum<SpecAddress['status'], T.CryptoDepositAddressStatus>(true);
sameEnum<SpecAddress['chain'], T.CryptoChain>(true);
sameEnum<NonNullable<Query<'/secure/market'>['sort']>, T.ItemSort>(true);
sameEnum<NonNullable<Query<'/secure/market'>['source']>, T.MarketSource>(true);
sameEnum<NonNullable<Query<'/secure/market/item'>['delivery']>, T.DeliveryFilter>(true);
sameEnum<NonNullable<Query<'/secure/market/item'>['phase']>, T.DopplerPhase>(true);
sameEnum<NonNullable<Query<'/v1/ledger/transactions'>['type']>, T.FundingType>(true);
sameEnum<NonNullable<Query<'/v1/ledger/transactions'>['status']>, T.FundingStatus>(true);
sameEnum<Body<'/secure/crypto/withdraw'>['chain'], T.CryptoChain>(true);
sameEnum<Body<'/secure/crypto/withdraw'>['token'], T.CryptoToken>(true);
