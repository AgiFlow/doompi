import { COMMAND_NAME, COMMAND_DESCRIPTION } from '../constants/computerUse';
// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ComputerUseExtensionService } from '../types/extension';

export function createComputerUseCommand(
  service: ComputerUseExtensionService,
): Parameters<ExtensionAPI['registerCommand']> {
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

export { COMMAND_NAME, COMMAND_DESCRIPTION } from '../constants/computerUse';
