import type { GitExtensionDependencies } from '../../types/extension';
import { DefaultGitExtensionService } from '../extensionService';
// @scaffold-generated
import { createWorktreeGit } from '../gitCli';
import { createWorktreeOperations } from '../worktreeOperations';

export function createGitDependencies(overrides: Partial<GitExtensionDependencies> = {}): GitExtensionDependencies {
  return {
    service: overrides.service ?? new DefaultGitExtensionService(),
    operations: overrides.operations ?? createWorktreeOperations({ git: createWorktreeGit() }),
  };
}
