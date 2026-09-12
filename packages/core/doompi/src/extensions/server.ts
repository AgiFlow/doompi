import { type DoomHeadlessCommand } from '@agimon-ai/doompi-extension-contracts/headless';
import { readMinorModeCatalog, type MinorModeCatalogService } from '@agimon-ai/doompi-extension-contracts/mode';
import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { api } from '../controllers/contextApi';
import { sessionFilesApi } from '../controllers/sessionFilesApi';
import { machineApi } from '../controllers/machineApi';
import { remoteApi } from '../controllers/remoteApi';
import {
  executeMinorModeCommand,
  MINOR_MODE_COMMAND,
  MINOR_MODE_COMMAND_DESCRIPTION,
} from '../services/minorModeCommand';

const headlessMinorModeCommand = (catalog: () => MinorModeCatalogService | undefined): DoomHeadlessCommand => ({
  name: MINOR_MODE_COMMAND,
  description: MINOR_MODE_COMMAND_DESCRIPTION,
  async execute(args, execution) {
    await executeMinorModeCommand(args, {
      catalog: catalog(),
      kind: 'headless',
      ui: {
        async select(title, options) {
          const result = await execution.client.request({
            kind: 'select',
            title,
            options: options.map((value) => ({ label: value, value })),
          });
          return typeof result === 'string' ? result : undefined;
        },
        async input(title, message) {
          const result = await execution.client.request({ kind: 'input', title, message });
          return typeof result === 'string' ? result : undefined;
        },
        async confirm(title, message) {
          const result = await execution.client.request({ kind: 'confirm', title, message });
          return typeof result === 'boolean' ? result : undefined;
        },
        notify: (message, level) => execution.client.notify({ body: message, level }),
      },
    });
  },
});

export const doompiServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi',
  global: ({ host }) => ({
    api: host.context.remoteControl ? [machineApi, remoteApi] : [machineApi],
  }),
  session: ({ context }) => ({
    api: [api, sessionFilesApi],
    commands: [headlessMinorModeCommand(() => readMinorModeCatalog(context))],
  }),
});

export default doompiServerFacet;
