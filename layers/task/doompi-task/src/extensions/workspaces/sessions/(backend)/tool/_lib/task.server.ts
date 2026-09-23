import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createHeadlessTaskTool } from '../../../../../../services/taskTool';
import type { TaskServerScope } from '../../_lib/root.server';

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TaskServerScope>) =>
  createHeadlessTaskTool(context.root.store, context.root.manager, context.root.maxTasks),
);
