/**
 * DoomPi core's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing context API owns all request behavior.
 * - Scope-aware. Context details belong to the agent session that produced them.
 *
 * AVOID:
 * - Starting work or retaining state in the facet lifecycle.
 */

import { readDoomHeadlessHost, type DoomHeadlessCommand } from '@agimon-ai/doompi-extension-contracts/headless';
import { readMinorModeCatalog, type MinorModeCatalogService } from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { api } from '../contextApi.ts';
import {
  executeMinorModeCommand,
  MINOR_MODE_COMMAND,
  MINOR_MODE_COMMAND_DESCRIPTION,
} from '../../services/minorModeCommand.ts';

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

export const doompiServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    const headless = host.scope === 'session' ? readDoomHeadlessHost(context) : undefined;
    if (host.scope !== 'session') return undefined;

    const apiRegistration = host.registerApi(api);
    const commandRegistration = headless?.registerCommand(
      headlessMinorModeCommand(() => readMinorModeCatalog(context)),
    );
    return () => {
      commandRegistration?.dispose();
      apiRegistration.dispose();
    };
  },
};
