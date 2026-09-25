import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CryptoDeposit, CryptoWithdrawal, Trade } from './types/api.js';
import type { ApprovalResponse, WebhookEvent } from './types/webhooks.js';

export type {
  ApprovalEvent,
  ApprovalResponse,
  CryptoDepositEvent,
  CryptoWithdrawApprovalEvent,
  CryptoWithdrawEvent,
  TradeEvent,
  UnknownWebhookEvent,
  WebhookEvent,
  WithdrawApprovalEvent,
} from './types/webhooks.js';

export const SIGNATURE_HEADER = 'x-assetpay-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookFailureReason =
  | 'missing_header'
  | 'malformed'
  | 'timestamp_out_of_range'
  | 'signature_mismatch'
  | 'invalid_json';

export class AssetPayWebhookError extends Error {
  override readonly name = 'AssetPayWebhookError';

  constructor(
    readonly reason: WebhookFailureReason,
    message: string,
  ) {
    super(message);
  }
}

export type RawBody = string | Uint8Array;

export type HeaderSource =
  | string
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

export interface VerifyWebhookOptions {
  secret: string | readonly string[];
  toleranceSeconds?: number | undefined;
  now?: Date | number | undefined;
}

export interface SignWebhookInput {
  body: RawBody | object;
  secret: string;
  id?: string | undefined;
  timestamp?: Date | string | undefined;
}

export interface SignedWebhook {
  header: string;
  headers: Record<string, string>;
  body: string;
  id: string;
  timestamp: string;
}

interface ParsedHeader {
  t: string;
  id: string;
  signatures: Buffer[];
}

const HEX_SIGNATURE = /^[0-9a-f]{64}$/i;

export function verifyWebhook(
  rawBody: RawBody,
  headers: HeaderSource,
  opts: VerifyWebhookOptions,
): WebhookEvent {
  const header = readSignatureHeader(headers);
  if (!header) {
    throw new AssetPayWebhookError('missing_header', `Missing ${SIGNATURE_HEADER} header`);
  }
  const parsed = parseSignatureHeader(header);

  const at = Date.parse(parsed.t);
  const now = opts.now === undefined ? Date.now() : new Date(opts.now).getTime();
  const tolerance = (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  if (Math.abs(now - at) > tolerance) {
    throw new AssetPayWebhookError(
      'timestamp_out_of_range',
      `Signature timestamp ${parsed.t} is outside the ${tolerance / 1000}s tolerance`,
    );
  }

  const secrets = (typeof opts.secret === 'string' ? [opts.secret] : opts.secret).filter(Boolean);
  if (secrets.length === 0) throw new TypeError('verifyWebhook: secret is required');
  const bytes = toBytes(rawBody);
  const matched = secrets.some((secret) => {
    const expected = digest(secret, parsed.id, parsed.t, bytes);
    return parsed.signatures.some((candidate) => timingSafeEqual(expected, candidate));
  });
  if (!matched) {
    throw new AssetPayWebhookError('signature_mismatch', 'Webhook signature does not match');
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new AssetPayWebhookError('invalid_json', 'Webhook body is not valid JSON');
  }
  return toEvent(body, parsed.id, parsed.t);
}

export function isCallbackTest(rawBody: RawBody | object, headers: HeaderSource): boolean {
  if (readSignatureHeader(headers)) return false;
  let body: unknown = rawBody;
  if (typeof rawBody === 'string' || rawBody instanceof Uint8Array) {
    try {
      body = JSON.parse(Buffer.from(toBytes(rawBody)).toString('utf8'));
    } catch {
      return false;
    }
  }
  return isObject(body) && body.test === true;
}

export function approve(): ApprovalResponse {
  return { status: 200, body: { action: 'approve' } };
}

export function reject(reason: string): ApprovalResponse {
  return { status: 200, body: { action: 'reject', reason } };
}

export function signWebhook(input: SignWebhookInput): SignedWebhook {
  const body =
    typeof input.body === 'string' || input.body instanceof Uint8Array
      ? Buffer.from(toBytes(input.body)).toString('utf8')
      : JSON.stringify(input.body);
  const id = input.id ?? randomUUID();
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : (input.timestamp ?? new Date().toISOString());
  const signature = digest(input.secret, id, timestamp, toBytes(body)).toString('hex');
  const header = `t=${timestamp},id=${id},s=${signature}`;
  return {
    header,
    headers: { [SIGNATURE_HEADER]: header, 'content-type': 'application/json' },
    body,
    id,
    timestamp,
  };
}

function digest(secret: string, id: string, t: string, body: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${id}.${t}.`).update(body).digest();
}

function toBytes(body: RawBody): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

function readSignatureHeader(source: HeaderSource): string | undefined {
  if (typeof source === 'string') return source || undefined;
  if (typeof (source as { get?: unknown }).get === 'function') {
    return (
      (source as { get(name: string): string | null | undefined }).get(SIGNATURE_HEADER) ??
      undefined
    );
  }
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (name.toLowerCase() !== SIGNATURE_HEADER) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' && first ? first : undefined;
  }
  return undefined;
}

function parseSignatureHeader(header: string): ParsedHeader {
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    parts.set(segment.slice(0, idx).trim(), segment.slice(idx + 1).trim());
  }
  const t = parts.get('t');
  const id = parts.get('id');
  const signatures = ['s', 's1']
    .map((scheme) => parts.get(scheme))
    .filter((sig): sig is string => sig !== undefined && HEX_SIGNATURE.test(sig))
    .map((sig) => Buffer.from(sig, 'hex'));
  if (!t || !id || signatures.length === 0 || Number.isNaN(Date.parse(t))) {
    throw new AssetPayWebhookError('malformed', `Malformed ${SIGNATURE_HEADER} header`);
  }
  return { t, id, signatures };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toEvent(body: unknown, deliveryId: string, timestamp: string): WebhookEvent {
  const base = { deliveryId, timestamp };
  if (isObject(body) && isObject(body.trade)) {
    const trade = body.trade as unknown as Trade;
    // Body alone decides: an approval misread as a plain event gets a 2xx, which approves it.
    if (trade.type === 'withdraw' && trade.status === 'initiated') {
      return { ...base, type: 'withdraw.approval', trade, dedupeKey: `approval:${trade.id}` };
    }
    return { ...base, type: 'trade', trade, dedupeKey: deliveryId };
  }
  if (isObject(body) && isObject(body.withdrawal)) {
    const withdrawal = body.withdrawal as unknown as CryptoWithdrawal;
    if (withdrawal.status === 'awaiting_approval') {
      return {
        ...base,
        type: 'crypto_withdraw.approval',
        withdrawal,
        dedupeKey: `approval:${withdrawal.id}`,
      };
    }
    return { ...base, type: 'crypto_withdraw', withdrawal, dedupeKey: deliveryId };
  }
  if (isObject(body) && isObject(body.deposit)) {
    const deposit = body.deposit as unknown as CryptoDeposit;
    return { ...base, type: 'crypto_deposit', deposit, dedupeKey: deliveryId };
  }
  return { ...base, type: 'unknown', body, dedupeKey: deliveryId };
}
