// @scaffold-generated
import type { GitExtensionResult, GitExtensionService } from '../../types/extension';

export class DefaultGitExtensionService implements GitExtensionService {
  async execute(): Promise<GitExtensionResult> {
    return { message: 'Show git worktrees owned by this session', level: 'info' };
  }
}
