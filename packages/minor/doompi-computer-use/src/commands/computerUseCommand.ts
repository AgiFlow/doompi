// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ComputerUseExtensionService } from '../types/extension.ts';

export const COMMAND_NAME = 'computer-use';
export const COMMAND_DESCRIPTION = 'Inspect or manage the session computer use mode';

export function registerComputerUseCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  service: ComputerUseExtensionService,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      const result = await service.execute();
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
    },
  });
}
