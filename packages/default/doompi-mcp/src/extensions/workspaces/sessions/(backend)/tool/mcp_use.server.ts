import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { McpServerScope } from '../_lib/serverRoot';
export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, McpServerScope>) => context.root.tools[0]!,
  {},
);
