import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { LogServerScope } from '../_lib/serverRoot';
export default defineHook((context: WithRoot<DoomServerPluginContext, LogServerScope>) => context.root.hooks[0]!);
