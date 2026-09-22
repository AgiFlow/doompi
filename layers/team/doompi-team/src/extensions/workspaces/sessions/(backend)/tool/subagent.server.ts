import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createHeadlessSubagentTool } from '../../../../../services/headlessSubagentTool';
import type { TeamServerScope } from '../_lib/root.server';

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TeamServerScope>) =>
  createHeadlessSubagentTool(context.root.runtime, context.root.execution),
);
