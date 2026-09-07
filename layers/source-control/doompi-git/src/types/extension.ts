// @scaffold-generated
import type { WorktreeOperations } from '../adapters/worktree/worktreeOperations.ts';

export type GitNotificationLevel = 'info';

export interface GitExtensionResult {
  message: string;
  level: GitNotificationLevel;
}

export interface GitExtensionService {
  execute(): Promise<GitExtensionResult>;
}

export interface GitExtensionDependencies {
  service: GitExtensionService;
  operations: WorktreeOperations;
}
