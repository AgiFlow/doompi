import type { AuthorOpenFileResult, AuthorToolResult, AuthorViewportCatalogSnapshot } from '../../types/author';
import type { AuthorCatalog } from './type';

class UnavailableAuthorCatalog implements AuthorCatalog {
  public open(): Promise<AuthorOpenFileResult> {
    return Promise.reject(new Error('The Author session service is unavailable.'));
  }

  public describe(): Promise<AuthorViewportCatalogSnapshot> {
    return Promise.reject(new Error('The Author session service is unavailable.'));
  }

  public execute(): Promise<AuthorToolResult> {
    return Promise.reject(new Error('The Author session service is unavailable.'));
  }
}

/** Uses an injected typed service directly. No internal transport is discovered here. */
export function createAuthorCatalog(host?: AuthorCatalog): AuthorCatalog {
  return host ?? new UnavailableAuthorCatalog();
}
