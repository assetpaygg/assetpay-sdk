export const META_SYMBOL: unique symbol = Symbol.for('assetpay-sdk.meta') as never;

export interface ResponseMeta {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  reconciled?: 'resent' | 'found' | undefined;
}

export function meta(value: unknown): ResponseMeta | undefined {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    return (value as { [k: symbol]: ResponseMeta | undefined })[META_SYMBOL];
  }
  return undefined;
}

export function attachMeta<T>(value: T, info: ResponseMeta): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    Object.defineProperty(value as object, META_SYMBOL, {
      value: info,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  return value;
}
