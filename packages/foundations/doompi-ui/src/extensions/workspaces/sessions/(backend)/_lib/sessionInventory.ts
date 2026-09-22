import type { DoomHeadlessCommand } from '@agimon-ai/doompi-core/headless';
import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

import { TOOLS_COMMAND } from '../../../../../constants/ui';
import { toolNames } from '../../../../../services/sessionToolInventory';

/**
 * The TUI shell itself stays Pi-only. Inventory is the shared part and is exposed
 * from session data rather than silently installing a fake editor/widget host.
 *
 * Inventory is a command, never a context resource. It reports the tools observed
 * in the transcript, which is not the tool surface the current selection exposes:
 * as a prompt section it listed tools the session had since gated out, directly
 * contradicting the `Available tools:` block, and it grew for the whole session.
 */
export function createUiServerContributions(): DoomServerSessionPlugin {
  return {
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
