import { defineServerCommand, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { RunnerServerScope } from '../_lib/serverRoot';
export default defineServerCommand(
  (context: WithRoot<DoomServerPluginContext, RunnerServerScope>) => context.root.command,
);
