import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { GitServerScope } from '../../_lib/root.server';

export default (context: WithRoot<DoomServerPluginContext, GitServerScope>) => context.root.resources[0]!;
