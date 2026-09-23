import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createMcpCommand } from '../../../../../services/mcpCommand';
import type { McpPiScope } from '../_lib/piRoot';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, McpPiScope>) =>
    [
      createMcpCommand(context.root.session, {
        openOverlay: async (ctx) => {
          const { openMcpOverlay } = await import('../../../../../tui/mcpOverlay');
          return openMcpOverlay(ctx, context.root.session);
        },
      }),
    ] as const,
  { cardinality: 'many' },
);
