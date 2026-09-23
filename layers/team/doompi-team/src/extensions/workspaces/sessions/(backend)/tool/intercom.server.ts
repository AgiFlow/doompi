import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createHeadlessIntercomTool } from '../../../../../services/headlessIntercomTool';
import type { TeamServerScope } from '../_lib/root.server';

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TeamServerScope>) =>
  createHeadlessIntercomTool(context.root.channel),
);
