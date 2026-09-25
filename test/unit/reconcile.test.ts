import { describe, expect, it } from 'vitest';
import { AssetPayError, meta } from '../../src/index.js';
import {
  API_SECRET,
  MERCHANT_ID,
  mockServer,
  STEAM_ID,
  sdk,
  TRADE_URL,
} from './support/mock-server.js';

const trade = { id: 'trade-1', externalId: 'order-1', status: 'initiated' };
const buy = {
  tradeUrl: TRADE_URL,
  items: [{ itemId: 'item-1', price: 10 }],
  externalId: 'order-1',
};

describe('reconcile', () => {
  // A lost response on a buy leaves the merchant not knowing whether money moved. The resend is
  // only safe because the server refuses a second trade under the same externalId, so it must
  // happen at most once and the answer must carry which path produced it.
  it('resends once and returns the trade the resend created', async () => {
    const server = mockServer().error('ECONNRESET').ok(trade);
    const result = await sdk(server, { reconcile: true }).trades.buy(buy);

    expect(result.id).toBe('trade-1');
    expect(meta(result)?.reconciled).toBe('resent');
    expect(server.calls.map((c) => c.path)).toEqual(['/secure/buy']);
    expect(server.calls[0]?.body).toMatchObject({ externalId: 'order-1' });
  });

  // The first attempt landed and only its response was lost: the duplicate refusal proves it,
  // and the caller must get that trade back rather than an error that reads as "not applied".
  it('returns the existing trade when the resend is refused as a duplicate', async () => {
    const server = mockServer()
      .reply(502, '<html>bad gateway</html>', { 'content-type': 'text/html' })
      .fail(409, 'EXTERNAL_ID_EXISTS')
      .ok(trade);
    const result = await sdk(server, { reconcile: true }).trades.buy(buy);

    expect(result.id).toBe('trade-1');
    expect(meta(result)?.reconciled).toBe('found');
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /secure/buy',
      'POST /secure/buy',
      'GET /secure/trades/order-1',
    ]);
  });

  // Reporting "failed" while the first attempt might still commit would let a merchant refund a
  // user whose withdraw then goes through. Without a trade to point at, the outcome stays unknown.
  it('stays ambiguous when no trade carries the externalId', async () => {
    const server = mockServer()
      .error('ECONNRESET')
      .fail(409, 'WITHDRAW_IN_PROGRESS')
      .fail(409, 'WITHDRAW_IN_PROGRESS')
      .fail(409, 'WITHDRAW_IN_PROGRESS')
      .fail(404, 'TRADE_NOT_FOUND');
    const error = await sdk(server, { reconcile: true, maxRetryWaitMs: 0 })
      .trades.buy(buy)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AssetPayError);
    expect(error).toMatchObject({ key: 'SDK_NETWORK', ambiguous: true });
  });

  // Client writes are looked up with the merchant key: the client token cannot read
  // /secure/trades, and a lookup that 401s would hide a trade that exists.
  it('looks up client writes with the merchant API key', async () => {
    const server = mockServer().error('ECONNRESET').fail(409, 'EXTERNAL_ID_EXISTS').ok(trade);
    const ap = sdk(server, { reconcile: true, apiSecret: API_SECRET, merchantId: MERCHANT_ID });
    const user = ap.asClient({ steamId: STEAM_ID, tradeUrl: TRADE_URL });
    const result = await user.trades.withdraw({
      items: [{ itemId: 'item-1', price: 10 }],
      externalId: 'order-1',
    });

    expect(meta(result)?.reconciled).toBe('found');
    const lookup = server.calls.at(-1);
    expect(lookup?.path).toBe('/secure/trades/order-1');
    expect(lookup?.headers['api-key']).toBe('ap_test');
    expect(lookup?.headers.authorization).toBeUndefined();
  });

  // Without an externalId there is nothing to make the resend safe, and without opt-in the
  // caller has said they reconcile themselves; either way a second send could double a trade.
  it('never resends without an externalId or without opt-in', async () => {
    const noId = mockServer().error('ECONNRESET');
    await expect(
      sdk(noId, { reconcile: true }).trades.buy({ ...buy, externalId: undefined }),
    ).rejects.toMatchObject({ ambiguous: true });

    const optedOut = mockServer().error('ECONNRESET');
    await expect(
      sdk(optedOut, { reconcile: true }).trades.buy(buy, { reconcile: false }),
    ).rejects.toMatchObject({ ambiguous: true });

    const definitive = mockServer().fail(400, 'PRICE_CHANGED');
    await expect(sdk(definitive, { reconcile: true }).trades.buy(buy)).rejects.toMatchObject({
      key: 'PRICE_CHANGED',
      ambiguous: false,
    });
    expect(definitive.calls).toHaveLength(1);
  });
});
