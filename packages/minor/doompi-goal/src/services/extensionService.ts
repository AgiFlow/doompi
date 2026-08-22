import type { GoalExtensionResult, GoalExtensionService } from '../types/extension.ts';

export class DefaultGoalExtensionService implements GoalExtensionService {
  async execute(): Promise<GoalExtensionResult> {
    return { message: 'Manage persistent goal execution', level: 'info' };
  }
}
