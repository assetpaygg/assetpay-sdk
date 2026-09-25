import { describe, expect, it } from 'vitest';
import {
  AssetPayWebhookError,
  approve,
  isCallbackTest,
  reject,
  signWebhook,
  verifyWebhook,
} from '../../src/webhooks.js';

// The vector the API's own signature tests pin. If the SDK ever disagrees with it, every
// merchant using verifyWebhook rejects every real delivery.
const VECTOR = {
  secret: 'current-secret',
  id: 'delivery-1',
  t: '2026-07-31T12:00:00.000Z',
  body: '{"event":"trade.completed","tradeId":"trade-1"}',
  signature: '264a1a0c4deb4462658b9cc21cce4bf2baaf8da9dd7dd1a51bbd71e0f4d81135',
};
const NOW = Date.parse(VECTOR.t);
const header = (s: string, extra = '') => `t=${VECTOR.t},id=${VECTOR.id},${s}${extra}`;

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AssetPayWebhookError) return err.reason;
    throw err;
  }
  throw new Error('expected verifyWebhook to throw');
}

describe('signature', () => {
  it('signs the API vector byte for byte', () => {
    const signed = signWebhook({
      body: VECTOR.body,
      secret: VECTOR.secret,
      id: VECTOR.id,
      timestamp: VECTOR.t,
    });
    expect(signed.header).toBe(header(`s=${VECTOR.signature}`));
  });

  it('verifies the API vector from a string, a Buffer and a Headers object', () => {
    const opts = { secret: VECTOR.secret, now: NOW };
    const sig = header(`s=${VECTOR.signature}`);
    expect(verifyWebhook(VECTOR.body, { 'X-AssetPay-Signature': sig }, opts).deliveryId).toBe(
      VECTOR.id,
    );
    expect(verifyWebhook(Buffer.from(VECTOR.body), sig, opts).type).toBe('unknown');
    expect(
      verifyWebhook(VECTOR.body, new Headers({ 'x-assetpay-signature': sig }), opts).timestamp,
    ).toBe(VECTOR.t);
  });

  // A forged or edited body must never reach a handler that credits balances.
  it('rejects a tampered body, a wrong secret and a re-signed id', () => {
    const sig = header(`s=${VECTOR.signature}`);
    const opts = { secret: VECTOR.secret, now: NOW };
    expect(failure(() => verifyWebhook(`${VECTOR.body} `, sig, opts))).toBe('signature_mismatch');
    expect(failure(() => verifyWebhook(VECTOR.body, sig, { ...opts, secret: 'other' }))).toBe(
      'signature_mismatch',
    );
    const swappedId = `t=${VECTOR.t},id=delivery-2,s=${VECTOR.signature}`;
    expect(failure(() => verifyWebhook(VECTOR.body, swappedId, opts))).toBe('signature_mismatch');
  });

  // While a rotated secret rolls out, the receiver carries both and either signature may match.
  it('accepts any configured secret against either s or s1', () => {
    const opts = { secret: ['new-secret', VECTOR.secret], now: NOW };
    expect(
      verifyWebhook(VECTOR.body, header(`s=${'0'.repeat(64)},s1=${VECTOR.signature}`), opts),
    ).toBeTruthy();
    expect(verifyWebhook(VECTOR.body, header(`s=${VECTOR.signature}`), opts)).toBeTruthy();
  });

  // Replayed deliveries outside the window are the classic webhook replay attack.
  it('enforces the timestamp tolerance in both directions', () => {
    const sig = header(`s=${VECTOR.signature}`);
    const at = (offsetS: number) => ({ secret: VECTOR.secret, now: NOW + offsetS * 1000 });
    expect(verifyWebhook(VECTOR.body, sig, at(300))).toBeTruthy();
    expect(verifyWebhook(VECTOR.body, sig, at(-300))).toBeTruthy();
    expect(failure(() => verifyWebhook(VECTOR.body, sig, at(301)))).toBe('timestamp_out_of_range');
    expect(failure(() => verifyWebhook(VECTOR.body, sig, at(-301)))).toBe('timestamp_out_of_range');
  });

  it('names missing and malformed headers', () => {
    const opts = { secret: VECTOR.secret, now: NOW };
    expect(failure(() => verifyWebhook(VECTOR.body, {}, opts))).toBe('missing_header');
    expect(
      failure(() => verifyWebhook(VECTOR.body, `t=${VECTOR.t},s=${VECTOR.signature}`, opts)),
    ).toBe('malformed');
    expect(failure(() => verifyWebhook(VECTOR.body, header('s=abc123'), opts))).toBe('malformed');
    expect(
      failure(() => verifyWebhook(VECTOR.body, `t=yesterday,id=x,s=${VECTOR.signature}`, opts)),
    ).toBe('malformed');
  });

  it('reports a correctly signed body that is not JSON as invalid_json', () => {
    const signed = signWebhook({ body: 'not json', secret: 's3cret', timestamp: new Date(NOW) });
    expect(
      failure(() => verifyWebhook(signed.body, signed.headers, { secret: 's3cret', now: NOW })),
    ).toBe('invalid_json');
  });
});

describe('event classification', () => {
  const deliver = (payload: object, id = 'd-1') => {
    const signed = signWebhook({ body: payload, secret: 'k', id, timestamp: new Date(NOW) });
    return verifyWebhook(signed.body, signed.headers, { secret: 'k', now: NOW });
  };

  // A withdraw approval must never read as a plain event: a generic handler answers plain
  // events with 200, and a 200 to an approval releases the withdrawal.
  it('reads an initiated withdraw as an approval, keyed by trade id', () => {
    const event = deliver({ trade: { id: 't-1', type: 'withdraw', status: 'initiated' } });
    expect(event.type).toBe('withdraw.approval');
    expect(event.dedupeKey).toBe('approval:t-1');
  });

  // Deposits also start out initiated; treating one as an approval would put a merchant's
  // approval logic in front of a deposit notification.
  it('reads an initiated deposit as a plain trade event, keyed by delivery id', () => {
    const event = deliver({ trade: { id: 't-2', type: 'deposit', status: 'initiated' } }, 'd-9');
    expect(event.type).toBe('trade');
    expect(event.dedupeKey).toBe('d-9');
  });

  it('separates crypto approvals, crypto events and unknown bodies', () => {
    expect(deliver({ withdrawal: { id: 'w-1', status: 'awaiting_approval' } })).toMatchObject({
      type: 'crypto_withdraw.approval',
      dedupeKey: 'approval:w-1',
    });
    expect(deliver({ withdrawal: { id: 'w-1', status: 'sent' } }).type).toBe('crypto_withdraw');
    expect(deliver({ deposit: { id: 'c-1', status: 'completed' } }).type).toBe('crypto_deposit');
    expect(deliver({ sale: { id: 's-1' } })).toMatchObject({
      type: 'unknown',
      body: { sale: { id: 's-1' } },
    });
  });
});

describe('callback test ping', () => {
  // The URL-save ping is unsigned. Answering it with 401 blocks the merchant from saving
  // their callback URL, which blocks every withdrawal.
  it('recognises only an unsigned body with test: true', () => {
    const ping = JSON.stringify({ test: true, timestamp: new Date().toISOString(), message: 'x' });
    expect(isCallbackTest(ping, {})).toBe(true);
    expect(isCallbackTest(Buffer.from(ping), {})).toBe(true);
    expect(isCallbackTest({ test: true }, {})).toBe(true);
    expect(isCallbackTest(ping, { 'x-assetpay-signature': 't=1,id=2,s=3' })).toBe(false);
    expect(isCallbackTest('{"trade":{}}', {})).toBe(false);
    expect(isCallbackTest('not json', {})).toBe(false);
  });

  it('builds the approval verdict bodies the API reads', () => {
    expect(approve()).toEqual({ status: 200, body: { action: 'approve' } });
    expect(reject('limit')).toEqual({ status: 200, body: { action: 'reject', reason: 'limit' } });
  });
});
