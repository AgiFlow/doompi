import type { GoalHistoryPort } from './history';

export type GoalNotificationLevel = 'info';

export interface GoalExtensionResult {
  message: string;
  level: GoalNotificationLevel;
}

export interface GoalExtensionService {
  execute(): Promise<GoalExtensionResult>;
}

export interface GoalExtensionDependencies {
  service: GoalExtensionService;
  history?: GoalHistoryPort;
}
