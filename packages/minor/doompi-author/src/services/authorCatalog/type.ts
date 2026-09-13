import type {
  AuthorOpenFileResult,
  AuthorToolResult,
  AuthorViewportCatalogSnapshot,
  UseAuthorToolInput,
} from '../../types/author';

/** Typed catalog supplied to Pi and headless Author tools. */
export interface AuthorCatalog {
  open(path: string, signal?: AbortSignal): Promise<AuthorOpenFileResult>;
  describe(signal?: AbortSignal): Promise<AuthorViewportCatalogSnapshot>;
  execute(input: UseAuthorToolInput, signal?: AbortSignal): Promise<AuthorToolResult>;
}
