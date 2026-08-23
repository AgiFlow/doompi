// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SandboxExtensionService } from '../types/extension.ts';

export const COMMAND_NAME = 'doom-sandbox';
export const COMMAND_DESCRIPTION = 'Show sandbox container status for this session';

export function registerSandboxCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  service: SandboxExtensionService,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      const result = await service.execute();
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
    },
  });
}
