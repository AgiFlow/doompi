import { defineDockFace } from '@agimon-ai/doompi-core/web';

import { ownsRun } from '../_lib/workflowActivity';
import { workflows } from '../_lib/workflowsStore';
import { WorkflowDockPanel } from './_components/WorkflowDockPanel';

export default defineDockFace({
  id: 'workflow',
  label: 'workflow',
  order: 20,
  autoSelect: true,
  panel: WorkflowDockPanel,
  // Shown in a session that owns a run: a workflow session, or one that ran a workflow itself before.
  visibility: {
    subscribe(listener: () => void) {
      const subscription = workflows.store.subscribe(listener);
      return () => subscription.unsubscribe();
    },
    isVisible(sessionId: string | null) {
      return workflows.select(workflows.store.state, sessionId).runs.some((run) => ownsRun(run, sessionId));
    },
  },
});
