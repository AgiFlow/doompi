import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { FileEditServerScope } from '../_lib/serverRoot';
export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, FileEditServerScope>) => context.root.hooks![0]!,
  {},
);
