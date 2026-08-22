import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { HelpActivationService } from '../../types/help.ts';

export const HELP_COMMAND_NAME = 'doom-help';
export const HELP_COMMAND_DESCRIPTION = 'Toggle package Help guidance';

export type RequireHelpActivation = () => HelpActivationService;

export function registerHelpCommand(
  pi: Pick<ExtensionAPI, 'registerCommand'>,
  requireActivation: RequireHelpActivation,
): void {
  pi.registerCommand(HELP_COMMAND_NAME, {
    description: HELP_COMMAND_DESCRIPTION,
    handler: async (_arguments, context) => {
      const activation = requireActivation();
      const current = activation.getState();
      const next = current.activation === 'inactive' ? await activation.activate() : activation.deactivate();
      if (!context.hasUI) return;
      const message = next.activation === 'inactive' ? 'Package Help deactivated.' : 'Package Help activated.';
      context.ui.notify(message, next.activation === 'degraded' ? 'warning' : 'info');
    },
  });
}
