import type {
  AuthorOpenFileResult,
  AuthorToolResult,
  AuthorViewportCatalogSnapshot,
  UseAuthorToolInput,
} from '../../types/author';

/** Typed catalog supplied to Pi and headless Author tools. */
export interface AuthorCatalog {
  open(path: string, signal?: AbortSignal, alias?: string): Promise<AuthorOpenFileResult>;
  describe(signal?: AbortSignal, alias?: string): Promise<AuthorViewportCatalogSnapshot>;
  execute(input: UseAuthorToolInput, signal?: AbortSignal): Promise<AuthorToolResult>;
}
