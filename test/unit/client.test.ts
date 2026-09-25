import { describe, expect, it } from 'vitest';
import { AssetPayError, isAmbiguous, meta } from '../../src/index.js';
import { decodeClientToken, mintClientToken } from '../../src/internal/token.js';
import {
  API_SECRET,
  MERCHANT_ID,
  mockServer,
  STEAM_ID,
  sdk,
  TRADE_URL,
} from './support/mock-server.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUY = { tradeUrl: TRADE_URL, items: [{ itemId: 'i-1', price: 1.5 }], externalId: 'order-1' };

async function caught(promise: Promise<unknown>): Promise<AssetPayError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AssetPayError) return err;
    throw err;
  }
  throw new Error('expected an AssetPayError');
}

describe('envelope and errors', () => {
  it('unwraps data, sends identity headers and exposes response meta', async () => {
    const server = mockServer().ok({
      balance: 10,
      pendingBalance: 0,
      escrowBalance: 0,
      currency: 'USD',
    });
    const balance = await sdk(server).wallet.balance();
    expect(balance.balance).toBe(10);
    const [call] = server.calls;
    expect(call?.path).toBe('/v1/wallets/me/balance');
    expect(call?.headers['api-key']).toBe('ap_test');
    expect(call?.headers['x-request-id']).toMatch(UUID_V4);
    expect(call?.headers['user-agent']).toMatch(/^assetpay-sdk\//);
    expect(meta(balance)?.status).toBe(200);
  });

  // fields and details are how a merchant learns which item was refused; dropping them turns
  // an actionable ITEM_OVERSTOCKED into a guess.
  it('keeps key, code, fields, details and array messages', async () => {
    const server = mockServer().fail(409, 'ITEM_OVERSTOCKED', {
      code: 1450,
      message: ['first', 'second'],
      fields: { 'items.0.itemId': 'bad' },
      details: { items: [{ itemId: 'i-1', remaining: 0 }] },
    });
    const err = await caught(
      sdk(server).trades.sell({ ...BUY, items: [{ itemId: 'i-1', price: 1 }] }),
    );
    expect(err).toMatchObject({
      key: 'ITEM_OVERSTOCKED',
      code: 1450,
      status: 409,
      message: 'first; second',
      messages: ['first', 'second'],
      fields: { 'items.0.itemId': 'bad' },
      details: { items: [{ itemId: 'i-1', remaining: 0 }] },
      ambiguous: false,
    });
  });

  it('reports a non-envelope 2xx as an invalid response, not a network error', async () => {
    const server = mockServer().reply(200, '<html>maintenance</html>', {
      'content-type': 'text/html',
    });
    const err = await caught(sdk(server).wallet.balance({ maxRetries: 0 }));
    expect(err.key).toBe('SDK_INVALID_RESPONSE');
    expect(err.status).toBe(200);
  });
});

describe('retries against the transport', () => {
  // Refused before the socket opened: the buy never reached the server, so sending it again
  // cannot create a second trade.
  it('repeats a buy after a connect-phase failure', async () => {
    const server = mockServer().error('ECONNREFUSED').ok({ id: 't-1' });
    const trade = await sdk(server).trades.buy(BUY);
    expect(trade.id).toBe('t-1');
    expect(server.agent.pendingInterceptors()).toHaveLength(0);
  });

  // The connection died after the buy was written. The server may have created the trade,
  // so a second send could buy twice. The caller must reconcile instead.
  it('does not repeat a buy after the socket drops mid-request', async () => {
    const server = mockServer().error('UND_ERR_SOCKET').ok({ id: 'would-be-duplicate' });
    const err = await caught(sdk(server).trades.buy(BUY));
    expect(err.key).toBe('SDK_NETWORK');
    expect(isAmbiguous(err)).toBe(true);
    expect(server.agent.pendingInterceptors()).toHaveLength(1);
  });

  it('does not repeat a buy after an unexplained 500', async () => {
    const server = mockServer()
      .reply(500, 'Internal', { 'content-type': 'text/plain' })
      .ok({ id: 'x' });
    const err = await caught(sdk(server).trades.buy(BUY));
    expect(err).toMatchObject({ status: 500, ambiguous: true });
    expect(server.calls).toHaveLength(1);
  });

  it('repeats a read after a 502', async () => {
    const server = mockServer().reply(502, 'Bad gateway', { 'content-type': 'text/html' }).ok([]);
    expect(await sdk(server).market.prices()).toEqual([]);
    expect(server.calls).toHaveLength(2);
  });

  it('repeats a refused deposit when the server asks to come back shortly', async () => {
    const server = mockServer()
      .fail(409, 'DEPOSIT_IN_PROGRESS', {}, { 'retry-after': '0' })
      .ok({ id: 't-2' });
    const trade = await sdk(server).trades.sell(BUY);
    expect(trade.id).toBe('t-2');
    expect(server.calls[0]?.headers['x-request-id']).toBe(server.calls[1]?.headers['x-request-id']);
  });

  // FLEET_DEGRADED asks for 30s. Blocking the caller that long by default would stall request
  // handlers; the caller gets the hint instead.
  it('surfaces a Retry-After beyond the wait cap instead of sleeping', async () => {
    const server = mockServer().fail(503, 'FLEET_DEGRADED', {}, { 'retry-after': '30' }).ok({});
    const err = await caught(sdk(server).clients.checkTradeUrl(TRADE_URL));
    expect(err).toMatchObject({ key: 'FLEET_DEGRADED', retryAfterMs: 30_000, ambiguous: false });
    expect(server.calls).toHaveLength(1);
  });

  it('never retries a rate limit', async () => {
    const server = mockServer().fail(429, 'RATE_LIMITED').ok([]);
    expect((await caught(sdk(server).market.prices())).key).toBe('RATE_LIMITED');
    expect(server.calls).toHaveLength(1);
  });

  // The server dedupes cashouts on requestId. A retry that minted a new one would send a
  // second on-chain payout.
  it('keeps one crypto withdraw requestId across retries', async () => {
    const server = mockServer().error('ECONNRESET').ok({ id: 'w-1' });
    await sdk(server).crypto.withdraw({
      steamId: STEAM_ID,
      chain: 'ETH',
      token: 'USDT',
      address: '0xabc',
      amountCents: 1000,
    });
    const body = server.calls[0]?.body as { requestId: string };
    expect(body.requestId).toMatch(UUID_V4);
    expect(server.agent.pendingInterceptors()).toHaveLength(0);
  });
});

describe('request shaping', () => {
  it('sends game as a string in bodies and a number in queries', async () => {
    const server = mockServer().ok({ id: 't' }).ok({ items: [], count: 0 });
    const ap = sdk(server);
    await ap.trades.sell({ ...BUY, game: 252490 });
    await ap.market.search({ game: 252490, development: false });
    expect(server.calls[0]?.body).toMatchObject({ game: '252490' });
    expect(server.calls[1]?.path).toBe('/secure/market?game=252490&development=false');
  });

  // An empty externalId cannot name a trade, and a comma splits it into two refs on lookup.
  it('rejects externalIds the API cannot round-trip before sending anything', async () => {
    const server = mockServer();
    const ap = sdk(server);
    expect((await caught(ap.trades.buy({ ...BUY, externalId: '' }))).fields).toHaveProperty(
      'externalId',
    );
    expect((await caught(ap.trades.buy({ ...BUY, externalId: 'a,b' }))).fields).toHaveProperty(
      'externalId',
    );
    expect(server.calls).toHaveLength(0);
  });

  it('batches getMany at 100 refs, dedupes, and returns an array for a lone ref', async () => {
    const refs = Array.from({ length: 101 }, (_, i) => `order-${i}`);
    const server = mockServer()
      .ok([{ id: 'a' }, { id: 'b' }])
      .fail(404, 'TRADE_NOT_FOUND');
    const trades = await sdk(server).trades.getMany([...refs, 'order-0']);
    expect(trades).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]?.path.split(',')).toHaveLength(100);
    expect(server.calls[1]?.path).toBe('/secure/trades/order-100');
  });

  it('follows trade cursors until nextCursor is null', async () => {
    const server = mockServer()
      .ok({ items: [{ id: '1' }], nextCursor: 'c2' })
      .ok({ items: [{ id: '2' }], nextCursor: null });
    const seen: string[] = [];
    for await (const t of sdk(server).trades.iterate({ game: 730 })) seen.push(t.id);
    expect(seen).toEqual(['1', '2']);
    expect(server.calls[1]?.path).toBe('/secure/trades?game=730&cursor=c2');
  });
});

describe('client sessions', () => {
  const identity = { steamId: STEAM_ID, tradeUrl: TRADE_URL };

  it('mints locally when secret and merchant id are configured', async () => {
    const server = mockServer().ok({ inventory: [], count: 0, updatedAt: '', collateral: 0 });
    const user = sdk(server, { apiSecret: API_SECRET, merchantId: MERCHANT_ID }).asClient(identity);
    await user.inventory.get({ game: 730 });
    const auth = server.calls[0]?.headers.authorization ?? '';
    expect(auth.startsWith('Bearer ')).toBe(true);
    expect(server.calls[0]?.headers['api-key']).toBeUndefined();
    expect(decodeClientToken(auth.slice(7)).claims.client.steamID).toBe(STEAM_ID);
  });

  it('asks the API once, then mints locally, when only the secret is configured', async () => {
    const remote = mintClientToken(identity, { apiSecret: API_SECRET, merchantId: MERCHANT_ID });
    const server = mockServer()
      .ok({ token: remote }, { path: '/auth/authenticate-client' })
      .ok({ items: [], nextCursor: null })
      .ok({ items: [], nextCursor: null });
    const ap = sdk(server, { apiSecret: API_SECRET });
    await ap.asClient(identity).trades.list();
    await ap.asClient({ ...identity, clientId: 'second' }).trades.list();
    expect(server.calls.map((c) => c.path)).toEqual([
      '/auth/authenticate-client',
      '/client/trades',
      '/client/trades',
    ]);
  });

  // A rotated secret or an expired token must heal on its own; the guard fails before any
  // side effect, so replaying the request after re-issuing is safe even for a deposit.
  it('re-issues the token once and replays after INVALID_TOKEN', async () => {
    const mint = (ttlSeconds: number) =>
      mintClientToken(identity, { apiSecret: API_SECRET, merchantId: MERCHANT_ID, ttlSeconds });
    const [stale, fresh] = [mint(3600), mint(7200)];
    const server = mockServer()
      .ok({ token: stale }, { path: '/auth/authenticate-client' })
      .fail(401, 'INVALID_TOKEN')
      .ok({ token: fresh }, { path: '/auth/authenticate-client' })
      .ok({ id: 't-9' });
    const trade = await sdk(server)
      .asClient(identity)
      .trades.deposit({ items: [{ itemId: 'a', price: 1 }] });
    expect(trade.id).toBe('t-9');
    expect(server.calls.map((c) => c.headers.authorization ?? c.path)).toEqual([
      '/auth/authenticate-client',
      `Bearer ${stale}`,
      '/auth/authenticate-client',
      `Bearer ${fresh}`,
    ]);
  });

  it('surfaces INVALID_TOKEN for a caller-supplied token it cannot renew', async () => {
    const token = mintClientToken(identity, { apiSecret: API_SECRET, merchantId: MERCHANT_ID });
    const server = mockServer().fail(401, 'INVALID_TOKEN');
    const err = await caught(sdk(server).withClientToken(token).trades.list());
    expect(err.key).toBe('INVALID_TOKEN');
    expect(server.calls).toHaveLength(1);
  });
});
