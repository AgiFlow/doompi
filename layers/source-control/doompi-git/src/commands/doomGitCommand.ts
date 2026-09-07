// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GitExtensionService } from '../types/extension.ts';

export const COMMAND_NAME = 'doom-git';
export const COMMAND_DESCRIPTION = 'Show git worktrees owned by this session';

export function registerGitCommand(pi: Pick<ExtensionAPI, 'registerCommand'>, service: GitExtensionService): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      const result = await service.execute();
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
    },
  });
}
