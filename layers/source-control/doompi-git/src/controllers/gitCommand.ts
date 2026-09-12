import { COMMAND_NAME, COMMAND_DESCRIPTION } from '../constants/git';
// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GitExtensionService } from '../types/extension';

export function createGitCommand(
  service: GitExtensionService,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    COMMAND_NAME,
    {
      description: COMMAND_DESCRIPTION,
      handler: async (_args, ctx) => {
        const result = await service.execute();
        if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
      },
    },
  ];
}
