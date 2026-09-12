import type { DoomHeadlessCommand } from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { toolNames } from '../services/sessionToolInventory';
import { TOOLS_COMMAND } from '../constants/ui';

/**
 * The TUI shell itself stays Pi-only. Inventory is the shared part and is exposed
 * from session data rather than silently installing a fake editor/widget host.
 */
export function createUiServerContributions(): DoomServerSessionPlugin {
  return {
    resources: [
      {
        name: 'doompi/tool-inventory',
        kind: 'context',
        read: async (execution) => {
          const names = toolNames(await execution.session.entries({ type: 'message' }));
          return names.length > 0 ? names.join('\n') : '(no tool calls recorded in this session)';
        },
      },
    ],
    commands: [
      {
        name: TOOLS_COMMAND,
        description: 'Show tools observed in this headless session. TUI rendering remains unavailable.',
        async execute(_args, execution) {
          await execution.client.notify({
            title: 'DoomPi tools',
            body:
              toolNames(await execution.session.entries({ type: 'message' })).join('\n') ||
              '(no tool calls recorded in this session)',
            level: 'info',
          });
        },
      } satisfies DoomHeadlessCommand,
    ],
  };
}
