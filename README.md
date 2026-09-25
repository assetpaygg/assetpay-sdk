# @assetpay/assetpay-sdk

[![npm](https://img.shields.io/npm/v/@assetpay/assetpay-sdk)](https://www.npmjs.com/package/@assetpay/assetpay-sdk)
[![CI](https://github.com/assetpaygg/assetpay-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/assetpaygg/assetpay-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Official TypeScript SDK for [AssetPay](https://assetpay.gg), the payment gateway for accepting CS2 and Rust skins: skin deposits and withdrawals, crypto cashouts, wallet and ledger reads, and webhook verification.

[Website](https://assetpay.gg/sdk) · [API reference](https://assetpay.gg/docs) · [Swagger UI](https://api.assetpay.gg/docs/public) · [Discord](https://discord.gg/5zgN9FNZaF)

- Typed methods for every public endpoint, for both merchant (API key) and end-user (client token) scopes
- Client tokens minted and refreshed for you
- Retries that never send a money-moving request twice
- Webhook and approval-callback verification, with a separate entry point that has no HTTP dependency
- An optional Socket.IO client for trade, deposit and market events

## Install

```bash
npm install @assetpay/assetpay-sdk
npm install socket.io-client   # only for @assetpay/assetpay-sdk/realtime
```

Requires Node.js 22.19 or newer. The package is ESM; CommonJS projects can `require()` it on Node 22.19+.

## Quickstart

```ts
import { AssetPay } from '@assetpay/assetpay-sdk';

const ap = new AssetPay({
  apiKey: process.env.ASSETPAY_API_KEY!,
  apiSecret: process.env.ASSETPAY_API_SECRET,
  merchantId: process.env.ASSETPAY_MERCHANT_ID,
});

const prices = await ap.market.prices({ game: 730 });
const { balance } = await ap.wallet.balance();

const user = ap.asClient({ steamId: '76561198000000001', tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=39734273&token=AbCdEf12' });
const { inventory } = await user.inventory.get({ game: 730 });
const deposit = await user.trades.deposit({
  items: [{ itemId: inventory[0].id, price: inventory[0].offer!.price }],
  externalId: 'deposit-1042',
});
```

Use `baseUrl: 'https://api-staging.assetpay.gg'` (exported as `STAGING_BASE_URL`) against staging.

## Before your first withdrawal

Every withdrawal, including your own `/secure/buy`, is sent to your callback URL for approval before anything is bought. Without a callback URL and an API secret configured in the dashboard, every withdrawal fails with `MERCHANT_NO_CALLBACK_URL` or `MERCHANT_NO_API_SECRET`. See [Webhooks](#webhooks) for the handler.

## Two scopes

| Scope | Credential | Access |
| --- | --- | --- |
| Merchant | `api-key` header | `ap.clients`, `ap.market`, `ap.inventory`, `ap.trades`, `ap.crypto`, `ap.wallet` |
| End user | client token (Bearer) | `ap.asClient(...)` returns `inventory`, `market`, `trades`, `crypto` for that user |

### Client tokens

`ap.asClient({ steamId, tradeUrl, clientId?, clientData? })` gets a token for that Steam user and keeps it fresh.

- With `apiSecret` and `merchantId` set, tokens are minted locally: no request, no rate limit.
- With only `apiSecret` set, the first token comes from the API and your merchant id is read from it; later tokens are minted locally.
- With neither, each session calls `POST /auth/authenticate-client` once.

Tokens live 24 hours and are renewed 5 minutes before expiry. If the API answers `INVALID_TOKEN`, the SDK issues a new token once and replays the request. Auth fails before anything else runs, so the replay is safe for deposits and withdrawals too.

To hand a token to your frontend, call `ap.mintClientToken(identity)`. To use a token issued elsewhere, call `ap.withClientToken(token)`; that session cannot renew it.

Identities are checked before any token is minted: `steamId` must be a SteamID64, `tradeUrl` must be a Steam trade offer URL, `clientId` must be at most 128 characters, and `clientData` keeps only `totalWager`, `registrationDate`, `kycHash`, `kycLevel`, `fiatDeposits` and `cryptoDeposits`.

## Methods

| Merchant | Client | Endpoint |
| --- | --- | --- |
| `clients.authenticate(identity)` | | `POST /auth/authenticate-client` |
| `clients.checkTradeUrl(url)` | | `POST /secure/check-tradeurl` |
| `market.prices({ game })` | | `GET /secure/prices` |
| `market.search(query)` | `market.search(query)` | `GET /secure/market`, `/client/market` |
| `market.listings(query)` | `market.listings(query)` | `GET .../market/item` |
| | `market.suggestions(q)` | `GET /client/market/suggestions` |
| `inventory.get({ tradeUrl })` | `inventory.get(query)` | `GET /secure/inventory`, `/client/inventory` |
| `trades.list`, `trades.iterate` | `trades.list`, `trades.iterate` | `GET /secure/trades`, `/client/trades` |
| `trades.get(ref)`, `trades.getMany(refs)` | | `GET /secure/trades/{ref}` |
| `trades.sell(input)` | `trades.deposit(input)` | `POST /secure/sell`, `/client/trading/deposit` |
| `trades.buy(input)` | `trades.withdraw(input)` | `POST /secure/buy`, `/client/trading/withdraw` |
| `trades.quickBuy(input)` | `trades.quickWithdraw(input)` | `POST .../quick` |
| `trades.cancel(id)`, `trades.cancelItem(id, itemId)` | same | `POST .../{tradeId}/cancel` |
| `crypto.depositAddress`, `deposits`, `withdrawals`, `withdraw` | same, without `steamId` | `/secure/crypto/*`, `/client/crypto/*` |
| `wallet.balance()` | | `GET /v1/wallets/me/balance` |
| `wallet.transactions(query)`, `wallet.transaction(id)` | | `GET /v1/ledger/transactions` |

Every method takes an optional last argument: `{ signal, timeoutMs, maxRetries, requestId, headers }`. The six trade-creating methods also take `reconcile` (see [Reconcile](#reconcile)).

Notes on the wire format:

- `game` is `730` (CS2) or `252490` (Rust). Most endpoints default to CS2.
- `trades.list` on the merchant scope returns only your own sells and buys. `trades.get(ref)` finds any of your trades, including end-user ones, by id or `externalId`.
- `trades.getMany(refs)` always returns an array, batches 100 refs per request, drops duplicates and skips refs that do not exist.
- Trade status is spelled `canceled`; crypto withdrawal status and cancel results are spelled `cancelled`.
- Trade prices are USD numbers. Crypto amounts are integer cents (`amountCents`).

## Retries and uncertain outcomes

The SDK retries only when it cannot cause a duplicate.

| Call | Retried on |
| --- | --- |
| Reads | network errors, timeouts, unexplained 5xx |
| `crypto.withdraw` | same as reads: the SDK sends one `requestId` for all attempts and the API returns the first cashout for a repeat |
| cancels | network errors |
| `sell`, `buy`, `quickBuy`, `deposit`, `withdraw`, `quickWithdraw` | only failures that prove nothing was sent (connection refused, DNS, connect timeout) |

All calls retry `FLEET_DEGRADED`, `DEPOSIT_IN_PROGRESS`, `WITHDRAW_IN_PROGRESS` and `ONCHAIN_CLIENT_WITHDRAW_BUSY`, which the API raises before doing anything. When the API asks to wait longer than `maxRetryWaitMs` (5s by default), the error is thrown at once with `retryAfterMs` set. `429` and other `503` answers are never retried.

When a trade-creating call fails after the request may have reached the API (the connection dropped, it timed out, or the server failed without explaining), the error has `ambiguous: true`. The trade may exist. Always send an `externalId` so the outcome can be settled.

### Reconcile

Turn on `reconcile` and the SDK settles an ambiguous outcome for you, for calls that carry an `externalId`:

```ts
const ap = new AssetPay({ apiKey, reconcile: true });
await ap.trades.buy({ tradeUrl, items, externalId: orderId });
await ap.trades.buy({ tradeUrl, items, externalId: orderId }, { reconcile: false }); // opt out per call
```

1. The SDK sends the same request once more. The API refuses a second trade under the same `externalId`, so this can never create two.
2. If the resend succeeds, you get that trade.
3. Otherwise the SDK looks the trade up by `externalId` (with your API key, also for end-user calls) and returns it if it exists.
4. If there is still no trade, the original `ambiguous` error is thrown.

`meta(result).reconciled` is `'resent'` or `'found'` when this happened. A found trade is returned as it stands, so check its `status`: it can already be `failed`. When a deposit was split into several trades, only the one carrying your `externalId` comes back; the others arrive through webhooks. A reconciled call can take up to twice its timeout.

Without `reconcile`, the same steps by hand:

```ts
import { isAmbiguous, isError } from '@assetpay/assetpay-sdk';

try {
  return await ap.trades.buy({ tradeUrl, items, externalId: orderId });
} catch (err) {
  if (!isAmbiguous(err)) throw err;
  try {
    return await ap.trades.buy({ tradeUrl, items, externalId: orderId });
  } catch (again) {
    if (isError(again, 'EXTERNAL_ID_EXISTS')) return ap.trades.get(orderId);
    throw err;
  }
}
```

An `externalId` is used up even when a deposit fails with a definitive error such as `NO_BOTS_AVAILABLE`, because the trade record already exists. Use a new one for a new attempt.

For `crypto.withdraw`, pass your own `requestId` (8 to 64 characters of `A-Z a-z 0-9 _ -`) if you need the retry to survive a process restart.

## Errors

Every failure is an `AssetPayError`:

```ts
{
  key: 'ITEM_OVERSTOCKED',     // stable string, see ErrorKey
  code: 45,                    // numeric API code, 0 for SDK-side errors
  status: 409,                 // HTTP status, 0 when no response arrived
  message: '...',
  messages: ['...'],           // validation errors can carry several
  fields: { 'items.0.price': '...' },
  details: { items: [{ itemId, marketHashName, remaining }] },
  requestId: '...',            // quote this to support
  retryAfterMs: 30000,
  ambiguous: false,
}
```

Helpers: `isError(err, key?)`, `isAuthError`, `isRateLimited`, `isValidationError`, `isAmbiguous`. SDK-side keys are `SDK_TIMEOUT`, `SDK_NETWORK`, `SDK_ABORTED` and `SDK_INVALID_RESPONSE`. Invalid input is rejected locally as `VALIDATION_FAILED` before a request is sent.

`meta(result)` returns `{ requestId, status, headers, reconciled? }` for any object or array the SDK returned.

## Pagination

```ts
for await (const trade of ap.trades.iterate({ game: 252490 })) { ... }
for await (const deposit of ap.crypto.iterateDeposits({ steamId })) { ... }
for await (const tx of ap.wallet.iterateTransactions({ type: 'DEPOSIT' })) { ... }
```

`market.search({ perPage: -1 })` returns the whole market in one response.

## Webhooks

AssetPay signs every delivery with your API secret:

```text
X-AssetPay-Signature: t=<ISO timestamp>,id=<delivery id>,s=<hex HMAC-SHA256 of "id.t.rawBody">
```

Verify against the raw request body, byte for byte. A parsed and re-serialised body will not match.

```ts
import {
  type ApprovalEvent,
  type HeaderSource,
  approve,
  isCallbackTest,
  reject,
  verifyWebhook,
} from '@assetpay/assetpay-sdk/webhooks';

export async function handle(rawBody: string | Buffer, headers: HeaderSource) {
  if (isCallbackTest(rawBody, headers)) return { status: 200, body: { ok: true } };

  const event = verifyWebhook(rawBody, headers, { secret: process.env.ASSETPAY_API_SECRET! });

  switch (event.type) {
    case 'withdraw.approval':
    case 'crypto_withdraw.approval': {
      const verdict = (await previousVerdict(event.dedupeKey)) ?? (await decide(event));
      await rememberVerdict(event.dedupeKey, verdict);
      return verdict;
    }
    case 'trade':
    case 'crypto_deposit':
    case 'crypto_withdraw':
      if (await alreadyHandled(event.dedupeKey)) return { status: 200, body: {} };
      await apply(event);
      return { status: 200, body: {} };
    default:
      return { status: 200, body: {} };
  }
}

async function decide(event: ApprovalEvent) {
  return (await canPay(event)) ? approve() : reject('insufficient balance');
}
```

- **The URL test ping is unsigned.** When you save a callback URL, AssetPay posts `{ "test": true, ... }` without a signature and needs a 2xx within 8 seconds. `isCallbackTest` recognises it. Answering it with 401 stops you saving the URL.
- **Approvals.** `withdraw.approval` and `crypto_withdraw.approval` ask you to accept a withdrawal. A 2xx approves it, unless the body says `{ "action": "reject", "reason": "..." }`. Any 4xx except 408 and 429 also rejects it. Each attempt times out after 10 seconds, and after 3 failed attempts the withdrawal is rejected. A plain `200` is an approval, so never answer an approval from a generic "acknowledge everything" handler.
- **Deduplication.** Regular events keep their delivery id across retries, so `dedupeKey` is the delivery id. Approval attempts each get a new delivery id, so their `dedupeKey` is the trade or withdrawal id. Store the verdict and return the same one for a repeat.
- **Event types.** Deliveries do not name their event; the SDK derives `type` from the body. Bodies it does not recognise come through as `type: 'unknown'` with the parsed `body`.
- **Secret rotation.** Pass `secret: [newSecret, oldSecret]` while you roll over; both `s` and `s1` are checked against every secret.
- **Clock skew.** Timestamps more than 300 seconds from your clock are rejected. Change it with `toleranceSeconds`.

Failures throw `AssetPayWebhookError` with `reason` set to `missing_header`, `malformed`, `timestamp_out_of_range`, `signature_mismatch` or `invalid_json`. Answer those with 401.

### Raw body recipes

Express:

```ts
app.post('/webhooks/assetpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const { status, body } = await handle(req.body, req.headers);
  res.status(status).json(body);
});
```

Fastify:

```ts
fastify.register(async (scope) => {
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  scope.post('/webhooks/assetpay', async (req, reply) => {
    const { status, body } = await handle(req.body as Buffer, req.headers);
    return reply.code(status).send(body);
  });
});
```

Next.js (App Router):

```ts
export async function POST(req: Request) {
  const { status, body } = await handle(await req.text(), req.headers);
  return Response.json(body, { status });
}
```

To test your handler, `signWebhook({ body, secret })` produces a correctly signed delivery.

## Realtime

`@assetpay/assetpay-sdk/realtime` streams trade updates, crypto deposits and market changes over Socket.IO. It needs `socket.io-client` installed and a merchant API key.

```ts
import { AssetPayRealtime } from '@assetpay/assetpay-sdk/realtime';

const feed = new AssetPayRealtime({ apiKey: process.env.ASSETPAY_API_KEY! });

feed.on('trade', (trade) => updateOrder(trade));
feed.on('deposit', (deposit) => showDeposit(deposit));
feed.on('market', (event) => {
  if (event.type === 'sync') return refetchMarket(event.reason === 'feed' ? event.game : undefined);
  if (event.type === 'remove') return dropListing(event.itemId);
  putListing(event.item);
});
feed.on('error', (err) => log.warn(err.reason, err.message));

await feed.connect();
```

- **Attach listeners before `connect()`.** After every connect and reconnect the first `market` event is `{ type: 'sync', reason: 'subscribe' }`. Changes made while you were disconnected are not replayed, so refetch the market when you see it.
- **`sync` with `reason: 'feed'`** means one game changed too much at once to send listing by listing. Refetch that `game`.
- **`upsert` and `patch`** both carry the full listing. When `at` is present, ignore an event older than one you already applied.
- **Events are not a ledger.** Nothing is replayed after a disconnect. Use webhooks for anything that moves money.
- **Reconnects are automatic**, including after the API restarts. If the key is refused later, `error` fires with `reason: 'auth_failed'` and the feed retries with a growing delay (30 seconds up to 5 minutes). Without an `error` listener these are dropped, never thrown.
- **`connect()` rejects** with `reason: 'auth_failed'` when the key is refused at startup, `'connect_failed'` when the API cannot be reached, and `'missing_peer'` when `socket.io-client` is not installed.
- `market` events need the `CORE_ACCESS` scope. Call `feed.close()` on shutdown.

Options: `{ apiKey, baseUrl, authWindowMs, authRetryMs, userAgent }`.

## Configuration

```ts
new AssetPay({
  apiKey: 'ap_...',
  apiSecret: '...',          // mints client tokens and verifies webhooks
  merchantId: '...',         // lets tokens be minted without a round trip
  baseUrl: 'https://api.assetpay.gg',
  timeoutMs: 30_000,         // sell and deposit use 100s
  maxRetries: 2,
  maxRetryWaitMs: 5_000,
  proxy: 'http://user:pass@egress.example:3128',  // static-IP egress for IP-whitelisted keys
  dispatcher: undefined,     // your own undici Dispatcher instead of the SDK's pool
  userAgent: 'my-shop/1.2',
  debug: (event) => console.log(event),           // one event per attempt, never includes credentials
  reconcile: false,          // settle ambiguous trade writes by externalId, see Reconcile
});
```

Each instance owns a connection pool. Call `await ap.close()` on shutdown.

## Support

Questions and integration help: [Discord](https://discord.gg/5zgN9FNZaF) or support@assetpay.gg. Bugs and feature requests: [GitHub issues](https://github.com/assetpaygg/assetpay-sdk/issues). Merchant accounts: [assetpay.gg](https://assetpay.gg/register).

## License

MIT
