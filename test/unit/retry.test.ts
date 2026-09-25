import { describe, expect, it } from 'vitest';
import {
  classify,
  type Failure,
  parseRetryAfter,
  type RetryClass,
} from '../../src/internal/http.js';

const CLASSES: RetryClass[] = ['safe', 'idempotent', 'repeatable', 'ambiguous'];
const connect: Failure = { kind: 'transport', phase: 'connect' };
const sent: Failure = { kind: 'transport', phase: 'sent' };
const http = (status: number, key: string, envelope = true): Failure => ({
  kind: 'http',
  status,
  key,
  envelope,
});

describe('classify', () => {
  // Nothing left the machine, so repeating even a withdraw cannot move money twice.
  it('retries connect-phase failures for every class', () => {
    for (const c of CLASSES)
      expect(classify(c, connect)).toEqual({ retry: true, ambiguous: false });
  });

  // These keys are raised before any side effect, so the retry is safe for buys and deposits.
  it('retries refusal keys for every class', () => {
    for (const key of [
      'FLEET_DEGRADED',
      'DEPOSIT_IN_PROGRESS',
      'WITHDRAW_IN_PROGRESS',
      'ONCHAIN_CLIENT_WITHDRAW_BUSY',
    ]) {
      for (const c of CLASSES) expect(classify(c, http(409, key)).retry).toBe(true);
    }
  });

  // The core money invariant: a buy, sell or deposit whose outcome is unknown is never sent
  // again, because the first one may have created a trade and debited the merchant.
  it('never repeats an ambiguous write once it may have reached the server', () => {
    expect(classify('ambiguous', sent)).toEqual({ retry: false, ambiguous: true });
    expect(classify('ambiguous', http(500, 'SERVER_ERROR'))).toEqual({
      retry: false,
      ambiguous: true,
    });
    expect(classify('ambiguous', http(502, 'SDK_INVALID_RESPONSE', false))).toEqual({
      retry: false,
      ambiguous: true,
    });
    expect(classify('ambiguous', { kind: 'aborted' })).toEqual({ retry: false, ambiguous: true });
  });

  it('treats a keyed server answer as definitive, not ambiguous', () => {
    expect(classify('ambiguous', http(503, 'DEPOSITS_PAUSED'))).toEqual({
      retry: false,
      ambiguous: false,
    });
    expect(classify('ambiguous', http(409, 'EXTERNAL_ID_EXISTS'))).toEqual({
      retry: false,
      ambiguous: false,
    });
    expect(classify('ambiguous', http(500, 'TRADE_OFFER_FAILED'))).toEqual({
      retry: false,
      ambiguous: false,
    });
  });

  it('retries reads through transport failures and unexplained 5xx only', () => {
    for (const c of ['safe', 'idempotent'] as const) {
      expect(classify(c, sent).retry).toBe(true);
      expect(classify(c, http(502, 'SDK_INVALID_RESPONSE', false)).retry).toBe(true);
      expect(classify(c, http(500, 'SERVER_ERROR')).retry).toBe(true);
      expect(classify(c, http(503, 'SYSTEM_MAINTENANCE')).retry).toBe(false);
      expect(classify(c, http(429, 'RATE_LIMITED')).retry).toBe(false);
      expect(classify(c, http(400, 'VALIDATION_FAILED')).retry).toBe(false);
    }
  });

  it('retries a cancel through a lost connection but not through a server error', () => {
    expect(classify('repeatable', sent)).toEqual({ retry: true, ambiguous: false });
    expect(classify('repeatable', http(500, 'SERVER_ERROR'))).toEqual({
      retry: false,
      ambiguous: false,
    });
  });

  it('never retries a caller abort', () => {
    for (const c of CLASSES) expect(classify(c, { kind: 'aborted' }).retry).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('Fri, 25 Sep 2026 12:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Fri, 25 Sep 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
