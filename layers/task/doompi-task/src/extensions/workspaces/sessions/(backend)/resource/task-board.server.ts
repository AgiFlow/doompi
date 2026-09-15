import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { TaskServerScope } from '../root.server';

export default (context: WithRoot<DoomServerPluginContext, TaskServerScope>) => ({
  name: 'doompi/task-board',
  kind: 'context' as const,
  read: () => JSON.stringify(context.root.store.snapshot, null, 2),
});
