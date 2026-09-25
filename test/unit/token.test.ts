import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssetPayError } from '../../src/errors.js';
import {
  ClientSession,
  decodeClientToken,
  mintClientToken,
  normalizeIdentity,
} from '../../src/internal/token.js';
import { API_SECRET, MERCHANT_ID, STEAM_ID, TRADE_URL } from './support/mock-server.js';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

function fields(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (err) {
    if (err instanceof AssetPayError && err.key === 'VALIDATION_FAILED') return err.fields ?? {};
    throw err;
  }
  throw new Error('expected a validation error');
}

describe('mintClientToken', () => {
  // The client guard picks the verifying secret from header.userId and rejects a merchantId
  // claim that disagrees, so both must name the merchant or every client call 401s.
  it('produces the header and claims the client guard verifies', () => {
    const token = mintClientToken(
      { steamId: STEAM_ID, tradeUrl: TRADE_URL, clientId: 'user-7' },
      { apiSecret: API_SECRET, merchantId: MERCHANT_ID, now: NOW },
    );
    const { header, claims } = decodeClientToken(token);
    expect(header).toEqual({ alg: 'HS256', userId: MERCHANT_ID });
    expect(claims).toEqual({
      merchantId: MERCHANT_ID,
      client: { steamID: STEAM_ID, tradeUrl: TRADE_URL, clientId: 'user-7' },
      iat: NOW / 1000,
      exp: NOW / 1000 + 86_400,
    });
    const [h, p, s] = token.split('.');
    expect(createHmac('sha256', API_SECRET).update(`${h}.${p}`).digest('base64url')).toBe(s);
  });

  // A token without exp would never expire, so a leaked one would work forever.
  it('never mints a token without an expiry or beyond 24h', () => {
    const id = { steamId: STEAM_ID, tradeUrl: TRADE_URL };
    const base = { apiSecret: API_SECRET, merchantId: MERCHANT_ID, now: NOW };
    expect(decodeClientToken(mintClientToken(id, { ...base, ttlSeconds: 60 })).claims.exp).toBe(
      NOW / 1000 + 60,
    );
    expect(fields(() => mintClientToken(id, { ...base, ttlSeconds: 86_401 }))).toHaveProperty(
      'ttlSeconds',
    );
    expect(fields(() => mintClientToken(id, { ...base, ttlSeconds: 0 }))).toHaveProperty(
      'ttlSeconds',
    );
  });

  // A locally minted token skips the server's DTO checks, so a bad trade URL would only
  // surface later as a failed trade offer.
  it('enforces the same identity rules as authenticate-client', () => {
    const problems = fields(() =>
      normalizeIdentity({
        steamId: '12345',
        tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=short',
        clientId: 'x'.repeat(129),
        clientData: { kycLevel: 1.5, totalWager: -1 },
      }),
    );
    expect(Object.keys(problems).sort()).toEqual([
      'clientData.kycLevel',
      'clientData.totalWager',
      'clientId',
      'steamId',
      'tradeUrl',
    ]);
  });

  it('keeps only known clientData keys and sends dates as ISO strings', () => {
    const identity = normalizeIdentity({
      steamId: STEAM_ID,
      tradeUrl: TRADE_URL,
      clientData: {
        registrationDate: new Date(NOW),
        kycLevel: 2,
        ...({ favouriteColour: 'blue' } as object),
      },
    });
    expect(identity.clientData).toEqual({
      registrationDate: '2026-09-25T12:00:00.000Z',
      kycLevel: 2,
    });
  });
});

describe('ClientSession', () => {
  it('reuses a token until five minutes before expiry, then reissues once', async () => {
    let now = NOW;
    let issued = 0;
    const session = new ClientSession(
      () => {
        issued++;
        return mintClientToken(
          { steamId: STEAM_ID, tradeUrl: TRADE_URL },
          { apiSecret: API_SECRET, merchantId: MERCHANT_ID, now, ttlSeconds: 3600 },
        );
      },
      undefined,
      () => now,
    );
    await Promise.all([session.token(), session.token()]);
    expect(issued).toBe(1);
    now += 54 * 60_000;
    await session.token();
    expect(issued).toBe(1);
    now += 2 * 60_000;
    await session.token();
    expect(issued).toBe(2);
  });

  it('cannot renew a token it did not mint', async () => {
    const token = mintClientToken(
      { steamId: STEAM_ID, tradeUrl: TRADE_URL },
      { apiSecret: API_SECRET, merchantId: MERCHANT_ID },
    );
    const session = new ClientSession(undefined, token);
    expect(await session.renew()).toBe(false);
    expect(await session.token()).toBe(token);
  });
});
