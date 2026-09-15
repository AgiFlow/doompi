import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { RunnerServerScope } from '../_lib/serverRoot';
export default defineServerTool((context: WithRoot<DoomServerPluginContext, RunnerServerScope>) => context.root.tool);
