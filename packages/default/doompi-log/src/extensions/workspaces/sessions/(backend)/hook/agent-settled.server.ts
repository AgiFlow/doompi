import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { LogServerScope } from '../_lib/serverRoot';
export default defineHook((context: WithRoot<DoomServerPluginContext, LogServerScope>) => context.root.hooks[1]!);
