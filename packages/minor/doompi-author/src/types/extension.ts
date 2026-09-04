import type { AuthorCatalog } from '../services/authorCatalog.ts';
export type AuthorNotificationLevel = 'info';

export interface AuthorExtensionResult {
  message: string;
  level: AuthorNotificationLevel;
}

export interface AuthorExtensionService {
  execute(): Promise<AuthorExtensionResult>;
}

export interface AuthorExtensionDependencies {
  catalog: AuthorCatalog;
  service: AuthorExtensionService;
}
