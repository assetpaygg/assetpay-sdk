import type { HttpClient, RequestOptions } from '../internal/http.js';
import { normalizeIdentity } from '../internal/token.js';
import type {
  CheckTradeUrlInput,
  ClientAuthToken,
  ClientIdentity,
  TradeUrlCheck,
} from '../types/api.js';

export class ClientsModule {
  constructor(private readonly http: HttpClient) {}

  async authenticate(identity: ClientIdentity, opts?: RequestOptions): Promise<ClientAuthToken> {
    const id = normalizeIdentity(identity);
    return this.http.send(
      {
        method: 'POST',
        path: '/auth/authenticate-client',
        body: {
          clientSteamId: id.steamId,
          clientTradeUrl: id.tradeUrl,
          clientId: id.clientId,
          clientData: id.clientData,
        },
        retry: 'safe',
      },
      opts,
    );
  }

  checkTradeUrl(input: CheckTradeUrlInput | string, opts?: RequestOptions): Promise<TradeUrlCheck> {
    const { tradeUrl, forceRefresh } = typeof input === 'string' ? { tradeUrl: input } : input;
    return this.http.send(
      {
        method: 'POST',
        path: '/secure/check-tradeurl',
        body: { tradeurl: tradeUrl, forceRefresh },
        retry: 'safe',
      },
      opts,
    );
  }
}
