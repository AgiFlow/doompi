import { defineHook } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { MinorModeServerScope } from '../_lib/serverScope';
export default defineHook((context: WithRoot<DoomServerPluginContext, MinorModeServerScope>) =>
  context.root.hooks.find((hook) => hook.event === 'session_shutdown')!,
);
