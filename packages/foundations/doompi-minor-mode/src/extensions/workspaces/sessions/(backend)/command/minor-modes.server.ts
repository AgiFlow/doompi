import { defineServerCommand } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { MinorModeServerScope } from '../_lib/serverScope';
export default defineServerCommand(
  (context: WithRoot<DoomServerPluginContext, MinorModeServerScope>) => context.root.commands[0]!,
);
