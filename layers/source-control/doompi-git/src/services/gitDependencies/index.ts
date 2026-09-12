// @scaffold-generated
import { createWorktreeGit } from '../gitCli';
import { DefaultGitExtensionService } from '../extensionService';
import { createWorktreeOperations } from '../worktreeOperations';
import type { GitExtensionDependencies } from '../../types/extension';

export function createGitDependencies(overrides: Partial<GitExtensionDependencies> = {}): GitExtensionDependencies {
  return {
    service: overrides.service ?? new DefaultGitExtensionService(),
    operations: overrides.operations ?? createWorktreeOperations({ git: createWorktreeGit() }),
  };
}
