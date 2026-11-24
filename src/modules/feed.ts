import { AssetPayError } from '../errors.js';
import type { HttpClient, RequestOptions } from '../internal/http.js';

/** Which listings to read: the pool's own stock, the external book, or both. */
export type FeedSource = 'internal' | 'external';
export type FeedSelection = FeedSource | 'all';

interface FeedSourceKeys {
  /** Hash: item key → item JSON. */
  items: string;
  /** Prefix: + item key is a hash of listing id → listing JSON. */
  rows: string;
  /** Prefix: + item key is a hash of listing id → your price ("12.34"). */
  prices: string;
  /** Stream: `type` (item.add, price.update, item.remove) and `data` `{ id, itemKey }`. */
  stream: string;
}

/** GET /secure/feed: your read-only login to the feed Redis. */
export interface FeedAccess {
  /** `rediss://user:password@host:port`: connect with it as is, with no INFO-based ready check. */
  url: string;
  host: string;
  port: number;
  tls: true;
  username: string;
  password: string;
  /** Most external listings held per item and phase. */
  depth: number;
  /** External instant listings held per item and phase when it has that many. */
  instantMin: number;
  keys: {
    /** Hash: `t`, `gen`, `frozen`, `depth`, `instantMin`. */
    state: string;
    /** Hash: `ready` is `1` once your prices are complete. */
    meta: string;
    internal: FeedSourceKeys;
    external: FeedSourceKeys;
  };
}

/**
 * The few calls the feed reader makes. An ioredis client fits as is; any client with a raw command
 * call does. Replies may be RESP2 (flat arrays) or RESP3 (maps).
 */
export interface FeedRedisClient {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  disconnect(): void;
}

/** ioredis: `import { Redis } from 'ioredis'` and pass `Redis`. */
export type FeedRedisConstructor = new (
  url: string,
  options: { enableReadyCheck: boolean; maxRetriesPerRequest: number | null },
) => FeedRedisClient;

/** One listing, joined from its item, its row and your price. */
export interface FeedListing {
  id: string;
  source: FeedSource;
  itemId: string | null;
  /** `itemId`, or `itemId:Phase_2` for a Doppler phase. */
  itemKey: string;
  phase: string | null;
  name: string | null;
  marketHashName: string | null;
  type: string | null;
  iconUrl: string | null;
  exterior: string | null;
  rarity: string | null;
  color: string | null;
  delivery: 'instant' | 'standard';
  /** USD decimal string, your pricing applied ("12.34"). Pass it to `/secure/buy` as `price`. */
  price: string;
  /** When the feed was last written (ISO), as of the read that set this listing. */
  updatedAt: string;
  wear?: string;
  paintSeed?: number;
  paintIndex?: number;
  stickers?: { name: string; [k: string]: unknown }[];
  assetId?: string;
  previewToken?: string;
  revertRefundPercent?: number;
  [k: string]: unknown;
}

export interface SyncFeedHandlers {
  /** After every (re)load; `feed.listings` is a new Map each time. */
  onReady?: (feed: SyncedFeed) => void;
  /** A listing entered the feed or changed (row or price). */
  onUpsert?: (listing: FeedListing) => void;
  onRemove?: (id: string, itemKey: string, source: FeedSource) => void;
  /** Read, connection and login failures. Only a refused login fetch (401/403) is fatal. */
  onError?: (err: AssetPayError | Error, fatal: boolean) => void;
}

export interface SyncFeedOptions {
  Redis: FeedRedisConstructor;
  /** Defaults to `all`. */
  source?: FeedSelection;
  /** Stream entries per read. Defaults to 1000. */
  batch?: number;
  /** How long one blocking read waits. Defaults to 5 s. */
  blockMs?: number;
  /** Backoff between failed attempts. Defaults: 1 s doubling to 60 s. */
  retry?: { baseDelayMs?: number; maxDelayMs?: number };
}

export interface SyncedFeed {
  readonly listings: Map<string, FeedListing>;
  /** True while the external book's upstream is unreachable or frozen: its prices may be stale. */
  readonly frozen: boolean;
  /** Settles after the first load: rejects only on a fatal error before it. */
  readonly ready: Promise<void>;
  close(): void;
}

type StoredItem = Pick<
  FeedListing,
  | 'itemId'
  | 'phase'
  | 'name'
  | 'marketHashName'
  | 'type'
  | 'iconUrl'
  | 'exterior'
  | 'rarity'
  | 'color'
>;

const READY_POLL_MS = 2_000;
const CHECK_MS = 10_000;
const ITEM_BATCH = 200;

export function feedAccess(http: HttpClient, opts?: RequestOptions): Promise<FeedAccess> {
  return http.send({ method: 'GET', path: '/secure/feed', retry: 'safe' }, opts);
}

function pairs(reply: unknown): [string, string][] {
  if (reply == null) return [];
  if (Array.isArray(reply)) {
    const out: [string, string][] = [];
    for (let i = 0; i + 1 < reply.length; i += 2)
      out.push([String(reply[i]), String(reply[i + 1])]);
    return out;
  }
  if (reply instanceof Map) return [...reply].map(([k, v]) => [String(k), String(v)]);
  return Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
}

type StreamEntry = [stream: string, id: string, fields: [string, string][]];

// RESP2 nests each stream as [name, entries]; a RESP3 map (ioredis 6) comes back flat: name, entries, ...
function streamGroups(reply: unknown): [string, unknown][] {
  if (reply == null) return [];
  if (reply instanceof Map) return [...reply].map(([k, v]) => [String(k), v]);
  if (!Array.isArray(reply)) return Object.entries(reply as Record<string, unknown>);
  if (reply.length > 0 && !Array.isArray(reply[0])) {
    const out: [string, unknown][] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) out.push([String(reply[i]), reply[i + 1]]);
    return out;
  }
  return reply.map((g) => [String((g as unknown[])[0]), (g as unknown[])[1]]);
}

function streamEntries(reply: unknown): StreamEntry[] {
  const groups = streamGroups(reply);
  const out: StreamEntry[] = [];
  for (const [stream, entries] of groups) {
    for (const e of (entries ?? []) as unknown[]) {
      const [id, fields] = e as [string, unknown];
      out.push([stream, String(id), pairs(fields)]);
    }
  }
  return out;
}

function compareIds(a: string, b: string): number {
  const [am = 0n, as = 0n] = a.split('-').map((x) => BigInt(x));
  const [bm = 0n, bs = 0n] = b.split('-').map((x) => BigInt(x));
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

// The newest id the stream trimmed away, or null when nothing was (or the stream does not exist yet).
async function trimPoint(c: FeedRedisClient, stream: string): Promise<string | null> {
  try {
    return (
      new Map(pairs(await c.call('XINFO', 'STREAM', stream))).get('max-deleted-entry-id') ?? null
    );
  } catch (err) {
    if (/no such key/i.test((err as Error)?.message ?? '')) return null;
    throw err;
  }
}

const stamp = (t: string): string => new Date(Number(t) || Date.now()).toISOString();

function join(
  source: FeedSource,
  itemKey: string,
  item: StoredItem,
  rowJson: string,
  price: string,
  updatedAt: string,
): FeedListing {
  const row = JSON.parse(rowJson) as { id: string; delivery: 'instant' | 'standard' };
  return { ...row, ...item, source, itemKey, price, updatedAt };
}

/**
 * A live copy of the feed from Redis: fetches the login, waits for your prices to be ready, loads
 * every item of the sources you chose, then follows their streams. Reloads when the feed is
 * refilled (`gen`), when a stream was trimmed past where it read, and after a login change
 * (NOPERM fetches the login again).
 */
export function syncFeed(
  http: HttpClient,
  handlers: SyncFeedHandlers,
  opts: SyncFeedOptions,
): SyncedFeed {
  const batch = opts.batch ?? 1_000;
  const blockMs = opts.blockMs ?? 5_000;
  const baseDelay = opts.retry?.baseDelayMs ?? 1_000;
  const maxDelay = opts.retry?.maxDelayMs ?? 60_000;
  const selection = opts.source ?? 'all';
  const sources: FeedSource[] = selection === 'all' ? ['internal', 'external'] : [selection];

  let listings = new Map<string, FeedListing>();
  const items = new Map<FeedSource, Map<string, StoredItem>>();
  let frozen = false;
  let closed = false;
  let cmd: FeedRedisClient | null = null;
  let reader: FeedRedisClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
  ready.catch(() => {});

  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      timer = setTimeout(() => {
        timer = null;
        done();
      }, ms);
    });

  const drop = () => {
    cmd?.disconnect();
    reader?.disconnect();
    cmd = null;
    reader = null;
  };

  const synced: SyncedFeed = {
    get listings() {
      return listings;
    },
    get frozen() {
      return frozen;
    },
    ready,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      drop();
    },
  };

  type Keys = FeedAccess['keys'];

  async function load(
    c: FeedRedisClient,
    keys: Keys,
  ): Promise<{ last: Map<string, string>; gen: string }> {
    const last = new Map<string, string>();
    for (const src of sources) {
      const stream = keys[src].stream;
      const tail = streamEntries([
        [stream, await c.call('XREVRANGE', stream, '+', '-', 'COUNT', 1)],
      ]);
      last.set(stream, tail[0]?.[1] ?? (await trimPoint(c, stream)) ?? '0-0');
    }
    const state = new Map(pairs(await c.call('HGETALL', keys.state)));
    frozen = state.get('frozen') === '1';
    const updatedAt = stamp(state.get('t') ?? '');
    const next = new Map<string, FeedListing>();
    for (const src of sources) {
      const k = keys[src];
      const held = new Map<string, StoredItem>();
      for (const [ik, v] of pairs(await c.call('HGETALL', k.items)))
        held.set(ik, JSON.parse(v) as StoredItem);
      items.set(src, held);
      const all = [...held];
      for (let i = 0; i < all.length; i += ITEM_BATCH) {
        const slice = all.slice(i, i + ITEM_BATCH);
        const read = await Promise.all(
          slice.flatMap(([ik]) => [
            c.call('HGETALL', k.rows + ik),
            c.call('HGETALL', k.prices + ik),
          ]),
        );
        slice.forEach(([ik, item], j) => {
          const prices = new Map(pairs(read[j * 2 + 1]));
          for (const [id, rowJson] of pairs(read[j * 2])) {
            const price = prices.get(id);
            if (price !== undefined) next.set(id, join(src, ik, item, rowJson, price, updatedAt));
          }
        });
      }
    }
    listings = next;
    return { last, gen: state.get('gen') ?? '' };
  }

  async function readItem(c: FeedRedisClient, k: FeedSourceKeys, src: FeedSource, ik: string) {
    const held = items.get(src)?.get(ik);
    if (held) return held;
    const raw = await c.call('HGET', k.items, ik);
    if (raw == null) return undefined;
    const item = JSON.parse(String(raw)) as StoredItem;
    items.get(src)?.set(ik, item);
    return item;
  }

  // Returns when the feed must be loaded again.
  async function follow(
    c: FeedRedisClient,
    r: FeedRedisClient,
    keys: Keys,
    from: { last: Map<string, string>; gen: string },
  ): Promise<void> {
    const last = from.last;
    const byStream = new Map(sources.map((src) => [keys[src].stream, src] as const));
    let checkedAt = Date.now();
    const forget = (id: string, src: FeedSource) => {
      const held = listings.get(id);
      if (held && held.source === src && listings.delete(id))
        handlers.onRemove?.(id, held.itemKey, src);
    };
    while (!closed) {
      const streams = [...last.keys()];
      const before = new Map(last);
      const entries = streamEntries(
        await r.call(
          'XREAD',
          'COUNT',
          batch,
          'BLOCK',
          blockMs,
          'STREAMS',
          ...streams,
          ...streams.map((s) => last.get(s) as string),
        ),
      );
      const latest = new Map<string, { src: FeedSource; type: string; itemKey: string }>();
      for (const [stream, id, fields] of entries) {
        last.set(stream, id);
        const src = byStream.get(stream);
        if (!src) continue;
        const f = new Map(fields);
        const data = JSON.parse(f.get('data') ?? '{}') as { id?: string; itemKey?: string };
        if (!data.id || !data.itemKey) continue;
        latest.delete(data.id);
        latest.set(data.id, { src, type: f.get('type') ?? '', itemKey: data.itemKey });
      }
      if (latest.size > 0) {
        const updatedAt = stamp(String((await c.call('HGET', keys.state, 't')) ?? ''));
        const repriced = (
          id: string,
          e: { src: FeedSource; type: string; itemKey: string },
        ): boolean => {
          const held = listings.get(id);
          return e.type === 'price.update' && held?.itemKey === e.itemKey && held.source === e.src;
        };
        // The whole batch is read at once: one round trip per batch, not per listing.
        const reads = await Promise.all(
          [...latest].map(async ([id, e]) => {
            if (e.type === 'item.remove') return null;
            const k = keys[e.src];
            const [price, rowJson] = await Promise.all([
              c.call('HGET', k.prices + e.itemKey, id),
              repriced(id, e) ? null : c.call('HGET', k.rows + e.itemKey, id),
            ]);
            const item = rowJson == null ? undefined : await readItem(c, k, e.src, e.itemKey);
            return { price, rowJson, item };
          }),
        );
        let i = 0;
        for (const [id, e] of latest) {
          const read = reads[i++];
          // A listing that lost its price or row since the entry was written is gone too.
          if (e.type === 'item.remove' || !read || read.price == null) {
            forget(id, e.src);
            continue;
          }
          const held = listings.get(id);
          if (held && repriced(id, e)) {
            held.price = String(read.price);
            held.updatedAt = updatedAt;
            handlers.onUpsert?.(held);
            continue;
          }
          if (read.rowJson == null || !read.item) {
            forget(id, e.src);
            continue;
          }
          const listing = join(
            e.src,
            e.itemKey,
            read.item,
            String(read.rowJson),
            String(read.price),
            updatedAt,
          );
          listings.set(id, listing);
          handlers.onUpsert?.(listing);
        }
      }
      // Trimmed past where this read started: entries between were deleted unread. A gap always
      // comes back as a full batch, since a stream holds far more than one batch after it.
      if (entries.length >= batch) {
        const trims = await Promise.all(streams.map((s) => trimPoint(c, s)));
        if (
          trims.some((t, i) => t && compareIds(t, before.get(streams[i] as string) as string) > 0)
        )
          return;
      }
      if (Date.now() - checkedAt < CHECK_MS) continue;
      checkedAt = Date.now();
      const state = new Map(pairs(await c.call('HGETALL', keys.state)));
      frozen = state.get('frozen') === '1';
      if ((state.get('gen') ?? '') !== from.gen) return;
    }
  }

  async function run(): Promise<void> {
    let attempt = 0;
    while (!closed) {
      try {
        const access = await feedAccess(http);
        drop();
        const options = { enableReadyCheck: false, maxRetriesPerRequest: null };
        const c = new opts.Redis(access.url, options);
        const r = new opts.Redis(access.url, options);
        cmd = c;
        reader = r;
        while (!closed && String((await c.call('HGET', access.keys.meta, 'ready')) ?? '') !== '1') {
          await sleep(READY_POLL_MS);
        }
        if (closed) return;
        for (;;) {
          const at = await load(c, access.keys);
          attempt = 0;
          handlers.onReady?.(synced);
          resolve();
          await follow(c, r, access.keys, at);
          if (closed) return;
        }
      } catch (err) {
        if (closed) return;
        const e = err as AssetPayError | Error;
        const fatal = e instanceof AssetPayError && (e.status === 401 || e.status === 403);
        handlers.onError?.(e, fatal);
        if (fatal) {
          closed = true;
          drop();
          reject(e);
          return;
        }
        // A NOPERM is a moved lane or a rotated password: the next login fetch fixes it.
        const wait = Math.min(maxDelay, baseDelay * 2 ** attempt);
        attempt++;
        await sleep(wait * (0.5 + Math.random() / 2));
      }
    }
  }

  void run();
  return synced;
}
