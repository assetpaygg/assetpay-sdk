import {
  AUTH_ERROR_KEYS,
  type ErrorKey,
  RATE_LIMIT_ERROR_KEYS,
  VALIDATION_ERROR_KEYS,
} from './types/errors.js';

export interface AssetPayErrorInit {
  key: ErrorKey;
  message: string;
  status?: number | undefined;
  code?: number | undefined;
  messages?: string[] | undefined;
  fields?: Record<string, string> | undefined;
  details?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
  retryAfterMs?: number | undefined;
  ambiguous?: boolean | undefined;
  cause?: unknown;
}

export class AssetPayError extends Error {
  override readonly name = 'AssetPayError';
  readonly key: ErrorKey;
  readonly code: number;
  readonly status: number;
  readonly messages: string[];
  readonly fields: Record<string, string> | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly ambiguous: boolean;

  constructor(init: AssetPayErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.key = init.key;
    this.code = init.code ?? 0;
    this.status = init.status ?? 0;
    this.messages = init.messages ?? [init.message];
    this.fields = init.fields;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.ambiguous = init.ambiguous ?? false;
  }
}

export function isError<K extends ErrorKey>(e: unknown, key?: K): e is AssetPayError & { key: K } {
  if (!(e instanceof AssetPayError)) return false;
  return key === undefined || e.key === key;
}

export function isAuthError(e: unknown): e is AssetPayError {
  return e instanceof AssetPayError && AUTH_ERROR_KEYS.has(e.key);
}

export function isRateLimited(e: unknown): e is AssetPayError {
  return e instanceof AssetPayError && RATE_LIMIT_ERROR_KEYS.has(e.key);
}

export function isValidationError(e: unknown): e is AssetPayError {
  return e instanceof AssetPayError && VALIDATION_ERROR_KEYS.has(e.key);
}

export function isAmbiguous(e: unknown): e is AssetPayError {
  return e instanceof AssetPayError && e.ambiguous;
}

export function invalidInput(fields: Record<string, string>): AssetPayError {
  const messages = Object.entries(fields).map(([path, why]) => `${path}: ${why}`);
  return new AssetPayError({
    key: 'VALIDATION_FAILED',
    message: messages.join('; '),
    messages,
    fields,
  });
}
