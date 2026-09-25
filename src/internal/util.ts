import { invalidInput } from '../errors.js';
import type { GameId } from '../types/api.js';

export function checkExternalId(externalId: string | undefined, path = 'externalId'): void {
  if (externalId === undefined) return;
  if (externalId.trim() === '') throw invalidInput({ [path]: 'must not be empty' });
  if (externalId.includes(',')) throw invalidInput({ [path]: 'must not contain a comma' });
  if (externalId.length > 128) throw invalidInput({ [path]: 'must be at most 128 characters' });
}

export function withBodyGame<T extends { game?: GameId | undefined }>(
  input: T,
): Omit<T, 'game'> & { game?: string } {
  const { game, ...rest } = input;
  return game === undefined ? rest : { ...rest, game: String(game) };
}

export function segment(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput({ [path]: 'must be a non-empty string' });
  }
  return encodeURIComponent(value);
}

export async function* paginate<P, T>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  items: (page: P) => readonly T[],
  next: (page: P) => string | null | undefined,
  start?: string,
): AsyncGenerator<T, void, undefined> {
  let cursor = start;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* items(page);
    const following = next(page);
    if (!following || following === cursor) return;
    cursor = following;
  }
}
