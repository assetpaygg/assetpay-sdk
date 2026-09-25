import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, type Dispatcher, ProxyAgent, request } from 'undici';
import { AssetPayError, invalidInput } from '../errors.js';
import { attachMeta, type ResponseMeta } from '../meta.js';
import type { ErrorKey } from '../types/errors.js';
import { SDK_VERSION } from './version.js';

export type RetryClass = 'safe' | 'idempotent' | 'repeatable' | 'ambiguous';

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  requestId?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface Call {
  method: 'GET' | 'POST';
  path: string;
  query?: object | undefined;
  body?: unknown;
  retry: RetryClass;
  timeoutMs?: number | undefined;
}

export interface Auth {
  headers(): Record<string, string> | Promise<Record<string, string>>;
  renew?(): Promise<boolean>;
}

export interface HttpEvent {
  requestId: string;
  method: string;
  path: string;
  attempt: number;
  durationMs: number;
  status?: number | undefined;
  key?: ErrorKey | undefined;
  retryInMs?: number | undefined;
}

export interface HttpConfig {
  baseUrl: string;
  auth: Auth;
  timeoutMs: number;
  maxRetries: number;
  maxRetryWaitMs: number;
  dispatcher: Dispatcher;
  userAgent: string;
  debug?: ((event: HttpEvent) => void) | undefined;
}

export type Failure =
  | { kind: 'transport'; phase: 'connect' | 'sent' }
  | { kind: 'http'; status: number; key: ErrorKey; envelope: boolean }
  | { kind: 'aborted' };

export interface Verdict {
  retry: boolean;
  ambiguous: boolean;
}

export const REFUSAL_KEYS: ReadonlySet<string> = new Set([
  'FLEET_DEGRADED',
  'DEPOSIT_IN_PROGRESS',
  'WITHDRAW_IN_PROGRESS',
  'ONCHAIN_CLIENT_WITHDRAW_BUSY',
]);

const TRANSIENT_STATUS: ReadonlySet<number> = new Set([
  500, 502, 503, 504, 520, 521, 522, 523, 524,
]);

const CONNECT_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_PRX_TLS',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function classify(retry: RetryClass, failure: Failure): Verdict {
  if (failure.kind === 'aborted') return { retry: false, ambiguous: retry === 'ambiguous' };
  if (failure.kind === 'transport') {
    if (failure.phase === 'connect') return { retry: true, ambiguous: false };
    if (retry === 'ambiguous') return { retry: false, ambiguous: true };
    return { retry: true, ambiguous: false };
  }
  if (REFUSAL_KEYS.has(failure.key)) return { retry: true, ambiguous: false };
  if (failure.status < 500) return { retry: false, ambiguous: false };
  const unexplained = !failure.envelope || failure.key === 'SERVER_ERROR';
  if (retry === 'ambiguous') return { retry: false, ambiguous: unexplained };
  if (retry === 'repeatable') return { retry: false, ambiguous: false };
  return { retry: unexplained && TRANSIENT_STATUS.has(failure.status), ambiguous: false };
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function backoffMs(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(4_000, 300 * 2 ** attempt);
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

export function createDispatcher(opts: {
  proxy?: string | undefined;
  connectTimeoutMs?: number | undefined;
}): Dispatcher {
  const connect = { timeout: opts.connectTimeoutMs ?? 10_000 };
  const shared = { connect, keepAliveTimeout: 30_000, connections: 64 };
  return opts.proxy ? new ProxyAgent({ uri: opts.proxy, ...shared }) : new Agent(shared);
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: AssetPayError; failure: Failure };

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  withAuth(auth: Auth): HttpClient {
    return new HttpClient({ ...this.config, auth });
  }

  async send<T>(call: Call, opts: RequestOptions = {}): Promise<T> {
    const requestId = opts.requestId ?? randomUUID();
    if (!UUID_V4.test(requestId)) throw invalidInput({ requestId: 'must be a UUIDv4' });
    const maxRetries = opts.maxRetries ?? this.config.maxRetries;
    let renewed = false;
    let attempt = 0;
    for (;;) {
      const started = performance.now();
      const outcome = await this.attempt<T>(call, requestId, opts);
      const event: HttpEvent = {
        requestId,
        method: call.method,
        path: call.path,
        attempt,
        durationMs: Math.round(performance.now() - started),
      };
      if (outcome.ok) {
        this.config.debug?.(event);
        return outcome.value;
      }
      const { error, failure } = outcome;
      event.status = error.status || undefined;
      event.key = error.key;

      if (error.key === 'INVALID_TOKEN' && !renewed && this.config.auth.renew) {
        renewed = true;
        this.config.debug?.(event);
        if (await this.config.auth.renew()) continue;
      }

      const verdict = classify(call.retry, failure);
      const wait = error.retryAfterMs ?? backoffMs(attempt);
      const retry =
        verdict.retry &&
        attempt < maxRetries &&
        wait <= this.config.maxRetryWaitMs &&
        !opts.signal?.aborted;
      if (retry) event.retryInMs = wait;
      this.config.debug?.(event);
      if (!retry) throw verdict.ambiguous ? markAmbiguous(error) : error;

      try {
        await sleep(wait, undefined, { signal: opts.signal });
      } catch {
        throw verdict.ambiguous ? markAmbiguous(error) : error;
      }
      attempt++;
    }
  }

  private async attempt<T>(
    call: Call,
    requestId: string,
    opts: RequestOptions,
  ): Promise<Outcome<T>> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? call.timeoutMs ?? this.config.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.config.userAgent,
      'x-request-id': requestId,
      ...(await this.config.auth.headers()),
      ...opts.headers,
    };
    let body: string | undefined;
    if (call.body !== undefined) {
      body = JSON.stringify(call.body);
      headers['content-type'] = 'application/json';
    }

    let status: number;
    let responseHeaders: Record<string, string>;
    let text: string;
    let sent = false;
    try {
      const res = await request(this.url(call.path, call.query), {
        method: call.method,
        headers,
        body: body ?? null,
        signal,
        dispatcher: this.config.dispatcher,
      });
      sent = true;
      status = res.statusCode;
      responseHeaders = flattenHeaders(res.headers);
      text = await res.body.text();
    } catch (err) {
      return transportFailure(err, requestId, opts.signal, timeout, sent);
    }

    const meta: ResponseMeta = { requestId, status, headers: responseHeaders };
    const json = parseJson(text);
    if (status >= 200 && status < 300) {
      if (isSuccessEnvelope(json)) {
        return {
          ok: true,
          value: attachMeta(json.data as T, { ...meta, requestId: json.requestId }),
        };
      }
      return invalidResponse(status, requestId, responseHeaders);
    }
    if (isErrorEnvelope(json)) {
      const error = fromEnvelope(status, json, responseHeaders);
      return {
        ok: false,
        error,
        failure: { kind: 'http', status, key: error.key, envelope: true },
      };
    }
    return invalidResponse(status, requestId, responseHeaders);
  }

  private url(path: string, query: object | undefined): string {
    const url = new URL(path.replace(/^\//, ''), `${this.config.baseUrl.replace(/\/+$/, '')}/`);
    if (query) {
      for (const [key, value] of Object.entries(query) as [string, QueryValue][]) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

export function markAmbiguous(error: AssetPayError): AssetPayError {
  if (error.ambiguous) return error;
  return new AssetPayError({
    key: error.key,
    code: error.code,
    status: error.status,
    message: `${error.message} (outcome unknown: the request may have been applied)`,
    messages: error.messages,
    fields: error.fields,
    details: error.details,
    requestId: error.requestId,
    retryAfterMs: error.retryAfterMs,
    ambiguous: true,
    cause: error.cause ?? error,
  });
}

function transportFailure(
  err: unknown,
  requestId: string,
  userSignal: AbortSignal | undefined,
  timeout: AbortSignal,
  sent: boolean,
): Outcome<never> {
  if (userSignal?.aborted) {
    return {
      ok: false,
      error: new AssetPayError({
        key: 'SDK_ABORTED',
        message: 'Request aborted',
        requestId,
        cause: err,
      }),
      failure: { kind: 'aborted' },
    };
  }
  const code = errorCode(err);
  const connect = !sent && code !== undefined && CONNECT_CODES.has(code);
  const timedOut = timeout.aborted || (code !== undefined && TIMEOUT_CODES.has(code));
  const key: ErrorKey = timedOut ? 'SDK_TIMEOUT' : 'SDK_NETWORK';
  const reason = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: new AssetPayError({
      key,
      message: timedOut ? 'Request timed out' : `Network error: ${code ?? reason}`,
      requestId,
      cause: err,
    }),
    failure: { kind: 'transport', phase: connect ? 'connect' : 'sent' },
  };
}

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const inner = (current as { cause?: unknown; errors?: unknown[] }).errors?.[0];
    current = (current as { cause?: unknown }).cause ?? inner;
  }
  return undefined;
}

function invalidResponse(
  status: number,
  requestId: string,
  headers: Record<string, string>,
): Outcome<never> {
  const contentType = headers['content-type'] ?? 'no content-type';
  const error = new AssetPayError({
    key: 'SDK_INVALID_RESPONSE',
    status,
    message: `Unexpected HTTP ${status} response (${contentType})`,
    requestId: headers['x-request-id'] ?? requestId,
    retryAfterMs: parseRetryAfter(headers['retry-after']),
  });
  return { ok: false, error, failure: { kind: 'http', status, key: error.key, envelope: false } };
}

interface SuccessEnvelope {
  requestId: string;
  success: true;
  data?: unknown;
}

interface ErrorEnvelopeShape {
  requestId?: string;
  success: false;
  error: {
    code?: number;
    key: string;
    message?: string | string[];
    fields?: Record<string, string>;
    details?: Record<string, unknown>;
  };
}

function isSuccessEnvelope(json: unknown): json is SuccessEnvelope {
  return (
    typeof json === 'object' &&
    json !== null &&
    (json as SuccessEnvelope).success === true &&
    typeof (json as SuccessEnvelope).requestId === 'string'
  );
}

function isErrorEnvelope(json: unknown): json is ErrorEnvelopeShape {
  if (typeof json !== 'object' || json === null) return false;
  const env = json as ErrorEnvelopeShape;
  return env.success === false && typeof env.error?.key === 'string';
}

function fromEnvelope(
  status: number,
  env: ErrorEnvelopeShape,
  headers: Record<string, string>,
): AssetPayError {
  const raw = env.error.message;
  const messages = Array.isArray(raw) ? raw.map(String) : [String(raw ?? env.error.key)];
  return new AssetPayError({
    key: env.error.key,
    code: env.error.code,
    status,
    message: messages.join('; '),
    messages,
    fields: env.error.fields,
    details: env.error.details,
    requestId: env.requestId ?? headers['x-request-id'],
    retryAfterMs: parseRetryAfter(headers['retry-after']),
  });
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function defaultUserAgent(): string {
  return `assetpay-sdk/${SDK_VERSION} node/${process.versions.node}`;
}
