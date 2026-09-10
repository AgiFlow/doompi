// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { COMMAND_DESCRIPTION, COMMAND_NAME } from '../schemas/sandboxCommands.ts';
export { COMMAND_DESCRIPTION, COMMAND_NAME };
import type { SandboxExtensionService } from '../types/extension.ts';

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
