import { randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { AssetPay, type AssetPayOptions } from '../../../src/index.js';

export const ORIGIN = 'https://api.test';

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Match = { method?: string; path?: string | RegExp | ((path: string) => boolean) };

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
    return out;
  }
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

export function mockServer() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(ORIGIN);
  const calls: Recorded[] = [];

  const intercept = (match: Match = {}) =>
    pool.intercept({
      path: match.path ?? (() => true),
      method: match.method ?? (() => true),
    });

  const server = {
    agent,
    calls,
    reply(status: number, body: unknown, headers: Record<string, string> = {}, match?: Match) {
      intercept(match).reply((opts) => {
        calls.push({
          method: opts.method,
          path: opts.path,
          headers: normalizeHeaders(opts.headers),
          body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined,
        });
        return {
          statusCode: status,
          data: typeof body === 'string' ? body : JSON.stringify(body),
          responseOptions: { headers: { 'content-type': 'application/json', ...headers } },
        };
      });
      return server;
    },
    ok(data: unknown, match?: Match) {
      return server.reply(200, { requestId: randomUUID(), success: true, data }, {}, match);
    },
    fail(
      status: number,
      key: string,
      extra: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) {
      return server.reply(
        status,
        {
          requestId: randomUUID(),
          success: false,
          error: { code: 1000, key, message: key, ...extra },
        },
        headers,
      );
    },
    error(code: string) {
      intercept().replyWithError(Object.assign(new Error(`mock ${code}`), { code }));
      return server;
    },
  };
  return server;
}

export function sdk(
  server: ReturnType<typeof mockServer>,
  opts: Partial<AssetPayOptions> = {},
): AssetPay {
  return new AssetPay({ apiKey: 'ap_test', baseUrl: ORIGIN, dispatcher: server.agent, ...opts });
}

export const STEAM_ID = '76561198000000001';
export const TRADE_URL =
  'https://steamcommunity.com/tradeoffer/new/?partner=39734273&token=AbCdEf12';
export const MERCHANT_ID = '0b9f9d9e-2f0e-4f7e-9a51-6f0f3c2c1a11';
export const API_SECRET = 'test-api-secret-value';
