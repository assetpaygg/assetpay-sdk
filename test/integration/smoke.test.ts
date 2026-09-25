import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetPay, STAGING_BASE_URL } from '../../src/index.js';
import { AssetPayRealtime } from '../../src/realtime.js';

const apiKey = process.env.ASSETPAY_TEST_API_KEY;
const steamId = process.env.ASSETPAY_TEST_STEAM_ID;
const tradeUrl = process.env.ASSETPAY_TEST_TRADE_URL;
const baseUrl = process.env.ASSETPAY_TEST_BASE_URL ?? STAGING_BASE_URL;

// Read-only on purpose: a smoke run against a shared environment must never move money.
describe.skipIf(!apiKey)('smoke', () => {
  let ap: AssetPay;

  beforeAll(() => {
    ap = new AssetPay({
      apiKey: apiKey ?? '',
      apiSecret: process.env.ASSETPAY_TEST_API_SECRET,
      baseUrl,
    });
  });
  afterAll(() => ap?.close());

  it('answers health', async () => {
    expect((await ap.health()).status).toBe('ok');
  });

  it('reads prices, market, trades and balance with the API key', async () => {
    expect(Array.isArray(await ap.market.prices({ game: 730 }))).toBe(true);
    expect(typeof (await ap.market.search({ game: 730, perPage: 5 })).count).toBe('number');
    expect(Array.isArray((await ap.trades.list({ limit: 5 })).items)).toBe(true);
    expect(typeof (await ap.wallet.balance()).balance).toBe('number');
  });

  it('opens the realtime feed with the API key', async () => {
    const feed = new AssetPayRealtime({ apiKey: apiKey ?? '', baseUrl });
    try {
      await feed.connect();
      expect(feed.connected).toBe(true);
    } finally {
      feed.close();
    }
  });

  it.skipIf(!steamId || !tradeUrl)('reads an inventory through a client session', async () => {
    const user = ap.asClient({ steamId: steamId ?? '', tradeUrl: tradeUrl ?? '' });
    expect(Array.isArray((await user.inventory.get({ game: 730, limit: 5 })).inventory)).toBe(true);
  });
});
