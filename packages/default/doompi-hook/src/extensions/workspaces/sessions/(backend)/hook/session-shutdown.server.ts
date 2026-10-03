import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { HookServerScope } from '../_lib/serverRoot';

export default defineHook(({ root }: WithRoot<DoomServerPluginContext, HookServerScope>) => root.sessionShutdown);
