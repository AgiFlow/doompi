import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { GitServerScope } from '../_lib/root.server';

export default defineHook((context: WithRoot<DoomServerPluginContext, GitServerScope>) => context.root.hooks[1]!);
