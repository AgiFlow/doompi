import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { bindMcpTool } from '../../../../../services/mcpTools';

export default defineRoutedContribution((context: DoomMcpPluginContext) => bindMcpTool(context, 'computer_exec'), {
  cardinality: 'optional',
});
