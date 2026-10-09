import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { FileEditServerScope } from '../_lib/serverRoot';
export default defineHook((context: WithRoot<DoomServerPluginContext, FileEditServerScope>) => context.root.hooks![0]!);
