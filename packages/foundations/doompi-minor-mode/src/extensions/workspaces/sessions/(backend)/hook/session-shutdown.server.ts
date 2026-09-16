import { defineHook } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { MinorModeServerScope } from '../_lib/serverScope';
export default defineHook((context: WithRoot<DoomServerPluginContext, MinorModeServerScope>) =>
  context.root.hooks.find((hook) => hook.event === 'session_shutdown')!,
);
