import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { activeTaskSnapshots, formatTaskSnapshots } from '../../../../../../services/contextContribution';
import type { TaskServerScope } from '../../_lib/root.server';

export default (context: WithRoot<DoomServerPluginContext, TaskServerScope>) => ({
  name: 'doompi/task-board',
  kind: 'context' as const,
  /**
   * The same bounded projection the Pi facet renders: open work only, one line each.
   * Dumping the whole TaskDocument put every completed task plus the store's own
   * version/rev/nextId bookkeeping in the prompt, and an idle board still cost a
   * paragraph. '' is dropped by the prompt composer.
   */
  read: () => {
    const rendered = formatTaskSnapshots(activeTaskSnapshots(context.root.store.snapshot.tasks));
    return rendered === '(no active tasks)' ? '' : rendered;
  },
});
