import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AssetPay, ScopedClient } from '../../src/index.js';
import {
  API_SECRET,
  MERCHANT_ID,
  mockServer,
  type Recorded,
  STEAM_ID,
  sdk,
  TRADE_URL,
} from './support/mock-server.js';

interface Operation {
  method: string;
  template: string;
  pattern: RegExp;
  auth: 'api-key' | 'client';
}

const EXCLUDED = /^\/client\/verification\//;

const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
};

const operations: Operation[] = Object.entries(spec.paths).flatMap(([template, ops]) =>
  Object.entries(ops)
    .filter(() => !EXCLUDED.test(template))
    .map(([method, op]) => ({
      method: method.toUpperCase(),
      template,
      pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
      auth: op.security?.some((s) => 'ClientToken' in s)
        ? ('client' as const)
        : ('api-key' as const),
    })),
);

type Invocation = (ap: AssetPay, user: ScopedClient) => Promise<unknown>;

const crypto = { chain: 'ETH', token: 'USDT', address: '0xabc', amountCents: 1000 } as const;
const invocations: Invocation[] = [
  (ap) => ap.clients.authenticate({ steamId: STEAM_ID, tradeUrl: TRADE_URL }),
  (ap) => ap.clients.checkTradeUrl(TRADE_URL),
  (ap) => ap.market.prices(),
  (ap) => ap.market.search(),
  (ap) => ap.market.listings({ marketHashName: 'AK-47 | Redline (Field-Tested)' }),
  (ap) => ap.inventory.get({ tradeUrl: TRADE_URL }),
  (ap) => ap.trades.list(),
  (ap) => ap.trades.get('t-1'),
  (ap) => ap.trades.getMany(['t-1', 't-2']),
  (ap) => ap.trades.sell({ tradeUrl: TRADE_URL, items: [{ itemId: 'i', price: 1 }] }),
  (ap) => ap.trades.buy({ tradeUrl: TRADE_URL, items: [{ itemId: 'i', price: 1 }] }),
  (ap) => ap.trades.quickBuy({ tradeUrl: TRADE_URL, marketHashName: 'x', maxPrice: 1, amount: 1 }),
  (ap) => ap.trades.cancel('t-1'),
  (ap) => ap.trades.cancelItem('t-1', 'i-1'),
  (ap) => ap.crypto.depositAddress({ steamId: STEAM_ID, chain: 'ETH' }),
  (ap) => ap.crypto.deposits({ steamId: STEAM_ID }),
  (ap) => ap.crypto.withdrawals({ steamId: STEAM_ID }),
  (ap) => ap.crypto.withdraw({ steamId: STEAM_ID, ...crypto }),
  (ap) => ap.wallet.balance(),
  (ap) => ap.wallet.transactions(),
  (ap) => ap.wallet.transaction('f-1'),
  (_, u) => u.inventory.get(),
  (_, u) => u.market.search(),
  (_, u) => u.market.listings({ itemId: 'i-1' }),
  (_, u) => u.market.suggestions('ak'),
  (_, u) => u.trades.list(),
  (_, u) => u.trades.deposit({ items: [{ itemId: 'i', price: 1 }] }),
  (_, u) => u.trades.withdraw({ items: [{ itemId: 'i', price: 1 }] }),
  (_, u) => u.trades.quickWithdraw({ marketHashName: 'x', maxPrice: 1, amount: 1 }),
  (_, u) => u.trades.cancel('t-1'),
  (_, u) => u.trades.cancelItem('t-1', 'i-1'),
  (_, u) => u.crypto.depositAddress({ chain: 'SOL' }),
  (_, u) => u.crypto.deposits(),
  (_, u) => u.crypto.withdrawals(),
  (_, u) => u.crypto.withdraw({ ...crypto }),
];

async function record(): Promise<Recorded[]> {
  const server = mockServer();
  for (let i = 0; i < invocations.length + 1; i++) server.ok([]);
  const ap = sdk(server, { apiSecret: API_SECRET, merchantId: MERCHANT_ID });
  const user = ap.asClient({ steamId: STEAM_ID, tradeUrl: TRADE_URL });
  for (const invoke of invocations) await invoke(ap, user);
  return server.calls.map((c) => ({ ...c, path: c.path.split('?')[0] ?? c.path }));
}

function operationFor(call: Recorded): Operation | undefined {
  return operations.find((op) => op.method === call.method && op.pattern.test(call.path));
}

// The published spec is what merchants read. An endpoint the SDK cannot reach, or a method
// that calls a route the API does not publish, is drift that should fail CI, not a merchant.
describe('public spec coverage', () => {
  it('reaches every public operation except verification', async () => {
    expect(operations).toHaveLength(34);
    const calls = await record();
    const missing = operations.filter(
      (op) => !calls.some((c) => c.method === op.method && op.pattern.test(c.path)),
    );
    expect(missing.map((op) => `${op.method} ${op.template}`)).toEqual([]);
  });

  it('only calls published routes, with the credential each one expects', async () => {
    const calls = await record();
    for (const call of calls) {
      const op = operationFor(call);
      expect(op, `${call.method} ${call.path}`).toBeDefined();
      const sent = call.headers.authorization?.startsWith('Bearer ') ? 'client' : 'api-key';
      expect(sent, `${call.method} ${call.path}`).toBe(op?.auth);
      if (sent === 'client') expect(call.headers['api-key']).toBeUndefined();
    }
  });
});
