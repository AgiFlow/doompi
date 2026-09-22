import { defineServerCommand } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { MinorModeServerScope } from '../_lib/serverScope';
export default defineServerCommand(
  (context: WithRoot<DoomServerPluginContext, MinorModeServerScope>) => context.root.commands[0]!,
);
