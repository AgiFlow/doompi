import { createAuthorCatalog } from '../adapters/pi/authorBridgeClient.ts';
import { DefaultAuthorExtensionService } from '../services/extensionService.ts';
import type { AuthorExtensionDependencies } from '../types/extension.ts';

export function createAuthorContainer(
  overrides: Partial<AuthorExtensionDependencies> = {},
): AuthorExtensionDependencies {
  return {
    catalog: overrides.catalog ?? createAuthorCatalog(),
    service: overrides.service ?? new DefaultAuthorExtensionService(),
  };
}
