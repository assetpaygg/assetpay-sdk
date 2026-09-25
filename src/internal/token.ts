import { createHmac } from 'node:crypto';
import { invalidInput } from '../errors.js';
import type { ClientData, ClientIdentity } from '../types/api.js';
import type { Auth } from './http.js';

export const STEAM_ID_REGEX = /^76561\d{12}$/;
export const TRADE_URL_REGEX =
  /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d{1,10}&token=[A-Za-z0-9_-]{8}$/;
export const CLIENT_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface MintClientTokenOptions {
  apiSecret: string;
  merchantId: string;
  ttlSeconds?: number | undefined;
  now?: number | undefined;
}

export interface ClientTokenClaims {
  merchantId: string;
  client: {
    steamID: string;
    tradeUrl: string;
    clientData?: Record<string, unknown>;
    clientId?: string;
  };
  iat: number;
  exp?: number;
}

export interface DecodedClientToken {
  header: { alg: string; userId?: string };
  claims: ClientTokenClaims;
}

export function normalizeIdentity(identity: ClientIdentity): ClientIdentity {
  const problems: Record<string, string> = {};
  if (!STEAM_ID_REGEX.test(identity.steamId)) {
    problems.steamId = 'must be a 17-digit SteamID64 starting with 76561';
  }
  if (!TRADE_URL_REGEX.test(identity.tradeUrl)) {
    problems.tradeUrl =
      'must be https://steamcommunity.com/tradeoffer/new/?partner=XXXXX&token=XXXXXXXX';
  }
  if (identity.clientId !== undefined && identity.clientId.length > 128) {
    problems.clientId = 'must be at most 128 characters';
  }
  const clientData =
    identity.clientData === undefined
      ? undefined
      : normalizeClientData(identity.clientData, problems);
  if (Object.keys(problems).length > 0) throw invalidInput(problems);

  const out: ClientIdentity = { steamId: identity.steamId, tradeUrl: identity.tradeUrl };
  if (identity.clientId !== undefined) out.clientId = identity.clientId;
  if (clientData !== undefined) out.clientData = clientData;
  return out;
}

function normalizeClientData(data: ClientData, problems: Record<string, string>): ClientData {
  const out: ClientData = {};
  if (data.totalWager !== undefined) {
    if (!Number.isFinite(data.totalWager) || data.totalWager < 0) {
      problems['clientData.totalWager'] = 'must be a non-negative number';
    }
    out.totalWager = data.totalWager;
  }
  if (data.registrationDate !== undefined) {
    const date = new Date(data.registrationDate);
    if (Number.isNaN(date.getTime())) {
      problems['clientData.registrationDate'] = 'must be a valid date';
    } else {
      out.registrationDate = date.toISOString();
    }
  }
  if (data.kycHash !== undefined) {
    if (typeof data.kycHash !== 'string') problems['clientData.kycHash'] = 'must be a string';
    out.kycHash = data.kycHash;
  }
  if (data.kycLevel !== undefined) {
    if (!Number.isInteger(data.kycLevel) || data.kycLevel < 0) {
      problems['clientData.kycLevel'] = 'must be a non-negative integer';
    }
    out.kycLevel = data.kycLevel;
  }
  if (data.fiatDeposits !== undefined) {
    if (typeof data.fiatDeposits !== 'boolean') {
      problems['clientData.fiatDeposits'] = 'must be a boolean';
    }
    out.fiatDeposits = data.fiatDeposits;
  }
  if (data.cryptoDeposits !== undefined) {
    if (typeof data.cryptoDeposits !== 'boolean') {
      problems['clientData.cryptoDeposits'] = 'must be a boolean';
    }
    out.cryptoDeposits = data.cryptoDeposits;
  }
  return out;
}

export function mintClientToken(identity: ClientIdentity, opts: MintClientTokenOptions): string {
  if (!opts.apiSecret) throw invalidInput({ apiSecret: 'is required to mint client tokens' });
  if (!opts.merchantId) throw invalidInput({ merchantId: 'is required to mint client tokens' });
  const ttl = opts.ttlSeconds ?? CLIENT_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > CLIENT_TOKEN_TTL_SECONDS) {
    throw invalidInput({
      ttlSeconds: `must be an integer between 1 and ${CLIENT_TOKEN_TTL_SECONDS}`,
    });
  }
  const id = normalizeIdentity(identity);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const client: ClientTokenClaims['client'] = { steamID: id.steamId, tradeUrl: id.tradeUrl };
  if (id.clientData !== undefined) client.clientData = { ...id.clientData };
  if (id.clientId !== undefined) client.clientId = id.clientId;

  const header = b64url(JSON.stringify({ alg: 'HS256', userId: opts.merchantId }));
  const payload = b64url(
    JSON.stringify({ merchantId: opts.merchantId, client, iat, exp: iat + ttl }),
  );
  const signature = createHmac('sha256', opts.apiSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function decodeClientToken(token: string): DecodedClientToken {
  const [header, payload] = token.split('.');
  try {
    if (!header || !payload) throw new Error('not a JWT');
    return {
      header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
      claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    };
  } catch {
    throw invalidInput({ token: 'is not a decodable client token' });
  }
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function expiresAt(token: string): number | undefined {
  try {
    const exp = decodeClientToken(token).claims.exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class ClientSession implements Auth {
  private current: { token: string; refreshAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly issue: (() => string | Promise<string>) | undefined,
    initial?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (initial !== undefined) this.store(initial);
  }

  async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token()}` };
  }

  async renew(): Promise<boolean> {
    if (!this.issue) return false;
    this.current = undefined;
    await this.token();
    return true;
  }

  async token(): Promise<string> {
    if (this.current && (this.now() < this.current.refreshAt || !this.issue)) {
      return this.current.token;
    }
    if (!this.issue) return this.current?.token ?? '';
    this.inflight ??= Promise.resolve()
      .then(() => this.issue!())
      .then((token) => this.store(token))
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private store(token: string): string {
    const exp = expiresAt(token);
    const refreshAt = exp === undefined ? Number.POSITIVE_INFINITY : exp - REFRESH_MARGIN_MS;
    this.current = { token, refreshAt };
    return token;
  }
}
