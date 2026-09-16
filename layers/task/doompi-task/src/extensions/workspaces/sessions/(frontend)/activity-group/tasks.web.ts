import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { isDelegationActive } from '../../../../../models/task';
import { tasks } from '../channel/_lib/tasksStore';

/**
 * The live task board in the session Activity dock.
 *
 * Active means a delegated run is still out, not that the list has entries. A
 * pending task waits for this agent's next turn and reports to nobody, so
 * counting it as running would leave the dock badge, the top bar and the
 * timeline's background-work notice claiming work that nothing will finish.
 */
export default defineActivityGroup({
  keys: 't l',
  statusKey: '@agimon-ai/doompi-task',
  marksBackgroundWork: false,
  activeSource: {
    subscribe(listener: () => void) {
      const subscription = tasks.store.subscribe(listener);
      return () => subscription.unsubscribe();
    },
    isActive(sessionId: string | null) {
      return tasks.select(tasks.store.state, sessionId).tasks.some(isDelegationActive);
    },
  },
  order: 65,
});
