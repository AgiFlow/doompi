import type { AuthorExtensionResult, AuthorExtensionService } from '../types/extension.ts';

export class DefaultAuthorExtensionService implements AuthorExtensionService {
  async execute(): Promise<AuthorExtensionResult> {
    return { message: 'Open the Author visual steering workspace', level: 'info' };
  }
}
