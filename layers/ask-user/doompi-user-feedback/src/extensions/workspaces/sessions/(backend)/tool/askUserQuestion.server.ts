import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { UserFeedbackServerScope } from '../_lib/root.server';
import { createAskUserHeadlessTool } from '../_tools/askUserHeadless';

export default defineServerTool((context: WithRoot<DoomServerPluginContext, UserFeedbackServerScope>) =>
  createAskUserHeadlessTool(context.root.coordinator),
);
