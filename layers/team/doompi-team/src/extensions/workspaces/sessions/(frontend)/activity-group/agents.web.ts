import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { subagentsTab } from '../_components/SubagentsPanel';
import { activityRuns, isTerminalRun, subagents } from '../_lib/subagentsStore';

/**
 * The dock group this package owns. The filename is the group name, which is
 * also the slot other plugins fill: `activity.agents`.
 *
 * It stays visible while the session is idle, because the group is the only
 * way into the fleet and a launcher that appears only once something runs
 * cannot be used to start anything.
 */
export default defineActivityGroup({
  keys: 'a r',
  statusKey: 'doom-team-agents',
  activeSource: {
    subscribe(listener: () => void) {
      const subscription = subagents.store.subscribe(listener);
      return () => subscription.unsubscribe();
    },
    isActive(sessionId: string | null) {
      return activityRuns(subagents.select(subagents.store.state, sessionId)).some((run) => !isTerminalRun(run));
    },
  },
  transientTab: subagentsTab,
  order: 10,
});
