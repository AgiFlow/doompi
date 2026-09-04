import type {
  AuthorOpenFileResult,
  AuthorToolResult,
  AuthorViewportCatalogSnapshot,
  UseAuthorToolInput,
} from '../types/author.ts';

/** Session API port used by the stable Pi Author tools. */
export interface AuthorCatalog {
  open(path: string, signal?: AbortSignal): Promise<AuthorOpenFileResult>;
  describe(signal?: AbortSignal): Promise<AuthorViewportCatalogSnapshot>;
  execute(input: UseAuthorToolInput, signal?: AbortSignal): Promise<AuthorToolResult>;
}
