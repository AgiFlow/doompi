import { HELP_COMMAND_NAME, HELP_COMMAND_DESCRIPTION } from '../constants/help';
import { defineCommand, type DoomPluginCommand } from '@agimon-ai/doompi-core/pi-extension';
import type { HelpActivationService } from '../types/help';

export type RequireHelpActivation = () => HelpActivationService;

export function createHelpCommand(requireActivation: RequireHelpActivation): DoomPluginCommand {
  return defineCommand({
    name: HELP_COMMAND_NAME,
    description: HELP_COMMAND_DESCRIPTION,
    execute: async (_arguments, execution) => {
      const activation = requireActivation();
      const current = activation.getState();
      const next = current.activation === 'inactive' ? await activation.activate() : activation.deactivate();
      const message = next.activation === 'inactive' ? 'Package Help deactivated.' : 'Package Help activated.';
      await execution.notify({ body: message, level: next.activation === 'degraded' ? 'warning' : 'info' });
    },
  });
}

export { HELP_COMMAND_NAME, HELP_COMMAND_DESCRIPTION } from '../constants/help';
