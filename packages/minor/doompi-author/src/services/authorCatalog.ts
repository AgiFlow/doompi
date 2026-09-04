import type { AuthorToolResult, AuthorViewportCatalogSnapshot, UseAuthorToolInput } from '../types/author.ts';

/** Session API port used by the stable Pi Author facades. */
export interface AuthorCatalog {
  describe(signal?: AbortSignal): Promise<AuthorViewportCatalogSnapshot>;
  execute(input: UseAuthorToolInput, signal?: AbortSignal): Promise<AuthorToolResult>;
}
