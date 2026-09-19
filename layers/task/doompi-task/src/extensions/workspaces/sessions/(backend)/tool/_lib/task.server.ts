import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createHeadlessTaskTool } from '../../../../../../services/taskTool';
import type { TaskServerScope } from '../../_lib/root.server';

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TaskServerScope>) =>
  createHeadlessTaskTool(context.root.store, context.root.manager, context.root.maxTasks),
);
