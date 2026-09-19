import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createHeadlessSubagentTool } from '../../../../../services/headlessSubagentTool';
import type { TeamServerScope } from '../_lib/root.server';

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TeamServerScope>) =>
  createHeadlessSubagentTool(context.root.runtime, context.root.execution),
);
