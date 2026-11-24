import { afterEach, describe, expect, it } from 'vitest';
import type { FeedRedisConstructor, SyncedFeed } from '../../src/index.js';
import { mockServer, sdk } from './support/mock-server.js';

const AK = 'a3f09c1d5e7b2468';
const AWP = 'b4e19d2c6f8a3579';
const OWN = '0199aaaa-bbbb-8ccc-8ddd-eeeeffff0001';
const EXT = '0199aaaa-bbbb-8ccc-8ddd-eeeeffff0002';
const source = (s: 'internal' | 'external') => ({
  items: `feed:${s}:items`,
  rows: `feed:${s}:rows:`,
  prices: `feed:l:lane:${s}:p:`,
  stream: `feed:${s}:stream`,
});
const KEYS = {
  state: 'feed:state',
  meta: 'feed:l:lane:meta',
  internal: source('internal'),
  external: source('external'),
};

const hashes = new Map<string, Map<string, string>>();
const streams = new Map<string, [string, string[]][]>();
let seq = 0;
let trimmed = '0-0';
let resp3 = false;

function hset(key: string, field: string, value: string) {
  const h = hashes.get(key) ?? new Map<string, string>();
  h.set(field, value);
  hashes.set(key, h);
}

function event(stream: string, type: string, id: string, itemKey: string) {
  const list = streams.get(stream) ?? [];
  list.push([`${++seq}-0`, ['type', type, 'data', JSON.stringify({ id, itemKey })]]);
  streams.set(stream, list);
}

const after = (id: string, than: string) => Number(id.split('-')[0]) > Number(than.split('-')[0]);

class FakeRedis {
  async call(command: string, ...args: (string | number)[]): Promise<unknown> {
    const a = args.map(String);
    switch (command) {
      case 'HGET':
        return hashes.get(a[0] as string)?.get(a[1] as string) ?? null;
      case 'HGETALL':
        return [...(hashes.get(a[0] as string) ?? new Map())].flat();
      case 'XREVRANGE':
        return (streams.get(a[0] as string) ?? []).slice(-1);
      case 'XINFO':
        return ['length', 0, 'max-deleted-entry-id', trimmed];
      case 'XREAD': {
        const names = a.slice(a.indexOf('STREAMS') + 1);
        const half = names.length / 2;
        const out: [string, [string, string[]][]][] = [];
        for (let i = 0; i < half; i++) {
          const name = names[i] as string;
          const pending = (streams.get(name) ?? []).filter(([id]) =>
            after(id, names[i + half] as string),
          );
          if (pending.length) out.push([name, pending]);
        }
        if (out.length === 0) {
          await new Promise((r) => setTimeout(r, 5));
          return null;
        }
        return resp3 ? out.flat(1) : out;
      }
      default:
        throw new Error(`unexpected ${command}`);
    }
  }

  disconnect() {}
}

const Redis = FakeRedis as unknown as FeedRedisConstructor;

function seed() {
  hashes.clear();
  streams.clear();
  seq = 0;
  trimmed = '0-0';
  resp3 = false;
  hset(KEYS.meta, 'ready', '1');
  hset(KEYS.state, 't', '1795500000000');
  hset(KEYS.state, 'gen', '1');
  hset(KEYS.state, 'frozen', '0');
  hset(
    KEYS.internal.items,
    AWP,
    JSON.stringify({ itemId: AWP, phase: null, name: 'AWP | Asiimov (Field-Tested)' }),
  );
  hset(
    KEYS.internal.rows + AWP,
    OWN,
    JSON.stringify({ id: OWN, delivery: 'instant', assetId: '41234567890' }),
  );
  hset(KEYS.internal.prices + AWP, OWN, '10.50');
  hset(
    KEYS.external.items,
    AK,
    JSON.stringify({ itemId: AK, phase: null, name: 'AK-47 | Redline (Field-Tested)' }),
  );
  hset(
    KEYS.external.rows + AK,
    EXT,
    JSON.stringify({ id: EXT, delivery: 'standard', paintSeed: 77 }),
  );
  hset(KEYS.external.prices + AK, EXT, '11.00');
}

const ACCESS = {
  url: 'rediss://m_x:pw@feed.assetpay.gg:6390',
  host: 'feed.assetpay.gg',
  port: 6390,
  tls: true,
  username: 'm_x',
  password: 'pw',
  depth: 100,
  instantMin: 30,
  keys: KEYS,
};

let feed: SyncedFeed | null = null;

afterEach(() => {
  feed?.close();
  feed = null;
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe('market.syncFeed', () => {
  it('loads both books at your prices and names the book of each listing', async () => {
    seed();
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed({}, { Redis });
    await feed.ready;
    expect(feed.listings.get(OWN)).toMatchObject({
      source: 'internal',
      price: '10.50',
      itemKey: AWP,
      assetId: '41234567890',
    });
    expect(feed.listings.get(EXT)).toMatchObject({
      source: 'external',
      price: '11.00',
      delivery: 'standard',
    });
    expect(feed.frozen).toBe(false);
  });

  it('reads only the book you ask for', async () => {
    seed();
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed({}, { Redis, source: 'internal' });
    await feed.ready;
    expect([...feed.listings.keys()]).toEqual([OWN]);
  });

  it('follows both streams', async () => {
    seed();
    const removed: string[] = [];
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed(
      { onRemove: (id, _ik, src) => removed.push(`${src}:${id}`) },
      { Redis },
    );
    await feed.ready;
    hset(KEYS.external.prices + AK, EXT, '12.00');
    event(KEYS.external.stream, 'price.update', EXT, AK);
    event(KEYS.internal.stream, 'item.remove', OWN, AWP);
    await until(() => feed?.listings.get(EXT)?.price === '12.00' && !feed.listings.has(OWN));
    expect(removed).toEqual([`internal:${OWN}`]);
  });

  it('follows both streams when Redis answers in RESP3', async () => {
    seed();
    resp3 = true;
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed({}, { Redis });
    await feed.ready;
    hset(KEYS.external.prices + AK, EXT, '12.00');
    event(KEYS.external.stream, 'price.update', EXT, AK);
    event(KEYS.internal.stream, 'item.remove', OWN, AWP);
    await until(() => feed?.listings.get(EXT)?.price === '12.00' && !feed.listings.has(OWN));
  });

  it('ignores a remove that names the other book', async () => {
    seed();
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed({}, { Redis });
    await feed.ready;
    event(KEYS.internal.stream, 'item.remove', EXT, AK);
    hset(KEYS.external.prices + AK, EXT, '13.00');
    event(KEYS.external.stream, 'price.update', EXT, AK);
    await until(() => feed?.listings.get(EXT)?.price === '13.00');
    expect(feed.listings.has(EXT)).toBe(true);
  });

  it('drops a listing whose price left your lane', async () => {
    seed();
    const removed: string[] = [];
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed(
      { onRemove: (id, _ik, src) => removed.push(`${src}:${id}`) },
      { Redis },
    );
    await feed.ready;
    hashes.get(KEYS.external.prices + AK)?.delete(EXT);
    event(KEYS.external.stream, 'price.update', EXT, AK);
    await until(() => !feed?.listings.has(EXT));
    expect(removed).toEqual([`external:${EXT}`]);
  });

  it('reloads when a stream was trimmed past where it read', async () => {
    seed();
    let loads = 0;
    feed = sdk(mockServer().ok(ACCESS)).market.syncFeed(
      {
        onReady: () => {
          loads++;
        },
      },
      { Redis, batch: 1 },
    );
    await feed.ready;
    hset(KEYS.external.prices + AK, EXT, '14.00');
    trimmed = '9-0';
    event(KEYS.internal.stream, 'price.update', OWN, AWP);
    await until(() => loads === 2 && feed?.listings.get(EXT)?.price === '14.00');
  });

  it('stops for good when the login is refused', async () => {
    seed();
    const errors: boolean[] = [];
    feed = sdk(mockServer().fail(403, 'FEED_NOT_ENABLED')).market.syncFeed(
      { onError: (_e, fatal) => errors.push(fatal) },
      { Redis },
    );
    await expect(feed.ready).rejects.toMatchObject({ status: 403 });
    expect(errors).toEqual([true]);
  });
});
