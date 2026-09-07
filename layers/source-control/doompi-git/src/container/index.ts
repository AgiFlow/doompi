// @scaffold-generated
import { createWorktreeGit } from '../adapters/worktree/gitCli.ts';
import { DefaultGitExtensionService } from '../services/extensionService.ts';
import { createWorktreeOperations } from '../adapters/worktree/worktreeOperations.ts';
import type { GitExtensionDependencies } from '../types/extension.ts';

export function createGitContainer(overrides: Partial<GitExtensionDependencies> = {}): GitExtensionDependencies {
  return {
    service: overrides.service ?? new DefaultGitExtensionService(),
    operations: overrides.operations ?? createWorktreeOperations({ git: createWorktreeGit() }),
  };
}
