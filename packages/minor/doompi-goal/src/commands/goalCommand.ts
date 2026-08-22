import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GoalExtensionService } from '../types/extension.ts';

export const COMMAND_NAME = 'goal';
export const COMMAND_DESCRIPTION = 'Manage persistent goal execution';

export function registerGoalCommand(pi: Pick<ExtensionAPI, 'registerCommand'>, service: GoalExtensionService): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      const result = await service.execute();
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
    },
  });
}
