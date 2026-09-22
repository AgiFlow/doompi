import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { RunnerServerScope } from '../_lib/serverRoot';
export default defineServerTool((context: WithRoot<DoomServerPluginContext, RunnerServerScope>) => context.root.tool);
