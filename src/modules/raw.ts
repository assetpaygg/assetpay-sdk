import type { HttpClient, RequestOptions, RetryClass } from '../internal/http.js';

export interface RawRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: object | undefined;
  body?: unknown;
  retry?: RetryClass | undefined;
}

export class RawModule {
  constructor(private readonly http: HttpClient) {}

  get<T = unknown>(path: string, query?: object, opts?: RequestOptions): Promise<T> {
    return this.http.send({ method: 'GET', path, query, retry: 'safe' }, opts);
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: RequestOptions & { retry?: RetryClass | undefined },
  ): Promise<T> {
    return this.http.send({ method: 'POST', path, body, retry: opts?.retry ?? 'ambiguous' }, opts);
  }

  request<T = unknown>(req: RawRequest, opts?: RequestOptions): Promise<T> {
    const retry = req.retry ?? (req.method === 'GET' ? 'safe' : 'ambiguous');
    return this.http.send({ ...req, retry }, opts);
  }
}
