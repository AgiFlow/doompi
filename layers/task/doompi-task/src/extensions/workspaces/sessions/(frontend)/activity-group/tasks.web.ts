import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { tasks } from '../channel/_lib/tasksStore';

/** The live task board in the session Activity dock. */
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
      return tasks.select(tasks.store.state, sessionId).tasks.length > 0;
    },
  },
  order: 65,
});
