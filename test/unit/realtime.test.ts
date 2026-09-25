import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetPayRealtime,
  type AssetPayRealtimeError,
  type MarketEvent,
} from '../../src/realtime.js';
import type { Trade } from '../../src/types/index.js';

const MERCHANT_ROOM = 'merchant:m-1';

// Mirrors the API gateway: websocket only, the key read from the handshake query, auth run
// after the socket opens, a bad key answered with a bare disconnect, and a subscribe sync for
// keys that can see the market.
async function gateway() {
  const keys = new Map<string, 'market' | 'plain'>([
    ['ap_market', 'market'],
    ['ap_plain', 'plain'],
  ]);
  const http = createServer();
  const io = new Server(http, { transports: ['websocket'] });
  let connections = 0;
  io.on('connection', async (socket) => {
    connections++;
    await delay(10);
    const scope = keys.get(String(socket.handshake.query.apiKey ?? ''));
    if (!scope) {
      socket.disconnect(true);
      return;
    }
    socket.join(MERCHANT_ROOM);
    if (scope === 'market') socket.emit('market', { type: 'sync', reason: 'subscribe' });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    io,
    keys,
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
}

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
});

async function setup(apiKey: string) {
  const gw = await gateway();
  open.push(gw);
  const rt = new AssetPayRealtime({ apiKey, baseUrl: gw.url, authWindowMs: 150, authRetryMs: 50 });
  open.push(rt);
  return { gw, rt };
}

describe('realtime', () => {
  // The subscribe sync is the only signal that deltas were missed while the socket was down; a
  // listener that misses it keeps showing prices from before the drop.
  it('delivers the subscribe sync to listeners attached before connect', async () => {
    const { gw, rt } = await setup('ap_market');
    const market: MarketEvent[] = [];
    const trades: Trade[] = [];
    rt.on('market', (event) => market.push(event));
    rt.on('trade', (trade) => trades.push(trade));
    await rt.connect();

    expect(market).toEqual([{ type: 'sync', reason: 'subscribe' }]);
    gw.io.to(MERCHANT_ROOM).emit('trade', { trade: { id: 'trade-1' } });
    await vi.waitFor(() => expect(trades).toEqual([{ id: 'trade-1' }]));
  });

  it('starts on a key without market access once the auth window passes', async () => {
    const { rt } = await setup('ap_plain');
    await rt.connect();
    expect(rt.connected).toBe(true);
  });

  // A wrong or revoked key at startup must fail loudly and stop: reconnecting forever would
  // hammer the API while the merchant believes the feed is up.
  it('rejects startup on a bad key and does not reconnect', async () => {
    const { gw, rt } = await setup('ap_revoked');
    await expect(rt.connect()).rejects.toMatchObject({ reason: 'auth_failed' });
    await delay(400);
    expect(gw.connections()).toBe(1);
    expect(rt.connected).toBe(false);
  });

  // Every deploy disconnects all sockets from the server side, and socket.io does not reconnect
  // after that on its own. Without this the first deploy silently ends every merchant's feed.
  it('reconnects after a server-initiated disconnect', async () => {
    const { gw, rt } = await setup('ap_market');
    const market: MarketEvent[] = [];
    rt.on('market', (event) => market.push(event));
    await rt.connect();

    gw.io.disconnectSockets(true);
    await vi.waitFor(() => expect(market).toHaveLength(2), { timeout: 3_000 });
    expect(rt.connected).toBe(true);
  });

  // An auth failure mid-life can be a revoked key or a transient server fault that looks the
  // same. The feed reports it, keeps retrying on a backoff, and recovers once auth passes again.
  it('reports an auth failure after startup and recovers when auth passes again', async () => {
    const { gw, rt } = await setup('ap_market');
    const errors: AssetPayRealtimeError[] = [];
    const market: MarketEvent[] = [];
    rt.on('error', (error) => errors.push(error));
    rt.on('market', (event) => market.push(event));
    await rt.connect();

    gw.keys.delete('ap_market');
    gw.io.disconnectSockets(true);
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(errors.every((e) => e.reason === 'auth_failed')).toBe(true);

    gw.keys.set('ap_market', 'market');
    await vi.waitFor(() => expect(market).toHaveLength(2), { timeout: 3_000 });
  });
});
