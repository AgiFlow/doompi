import { defineServerCommand, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { LogServerScope } from '../_lib/serverRoot';
export default defineServerCommand(
  (context: WithRoot<DoomServerPluginContext, LogServerScope>) => context.root.commands[0]!,
);
