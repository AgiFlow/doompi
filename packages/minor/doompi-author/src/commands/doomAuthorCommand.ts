import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AuthorExtensionService } from '../types/extension.ts';

export const COMMAND_NAME = 'doom-author';
export const COMMAND_DESCRIPTION = 'Open the Author visual steering workspace';

export function registerAuthorCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  service: AuthorExtensionService,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      const result = await service.execute();
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
    },
  });
}
