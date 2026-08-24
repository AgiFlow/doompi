import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { RunnersActivitySection } from './RunnersActivitySection.tsx';
import { bindRunnersRuntime, runnerRunsChannel } from './runnersStore.ts';

/**
 * This package's cockpit presence. The activity dock shows the runners group
 * whenever the session publishes the 'doom-runner-runners' footer status;
 * the group's body is this plugin's own list of the session's runners, fed by
 * the 'runner_runs' hub channel, with a stop control per running one.
 */
export const webPlugin = defineWebPlugin({
  id: 'runner',
  channels: [runnerRunsChannel],
  activityGroups: [{ name: 'runners', keys: 'r l', statusKey: 'doom-runner-runners', order: 20 }],
  // Same name as the group: the dock renders this inside it, in place of the
  // footer's one-line count.
  activitySections: [{ id: 'runners', component: RunnersActivitySection }],
  start: bindRunnersRuntime,
});
