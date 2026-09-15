import type { DoomHeadlessCommand } from '@agimon-ai/doompi-core/headless';

import type { MinorModeCatalogService } from '../../schemas/mode';
import { executeMinorModeCommand, MINOR_MODE_COMMAND, MINOR_MODE_COMMAND_DESCRIPTION } from '../command';
export function headlessMinorModeCommand(catalog: MinorModeCatalogService): DoomHeadlessCommand {
  return {
    name: MINOR_MODE_COMMAND,
    description: MINOR_MODE_COMMAND_DESCRIPTION,
    async execute(args, execution) {
      const executionClient = execution.client;
      await executeMinorModeCommand(args, {
        catalog,
        kind: 'headless',
        ui: {
          async select(title, options) {
            const selected = await executionClient.request({
              kind: 'select',
              title,
              options: options.map((label) => ({ label, value: label })),
            });
            return typeof selected === 'string' ? selected : undefined;
          },
          async input(title, message) {
            const entered = await executionClient.request({ kind: 'input', title, message });
            return typeof entered === 'string' ? entered : undefined;
          },
          async confirm(title, message) {
            const confirmed = await executionClient.request({ kind: 'confirm', title, message });
            return typeof confirmed === 'boolean' ? confirmed : undefined;
          },
          notify: (message, level) => executionClient.notify({ body: message, level }),
        },
      });
    },
  };
}
