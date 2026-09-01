import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { BashToolMessage } from './BashToolMessage.tsx';
import { RunnersActivitySection } from './RunnersActivitySection.tsx';
import { runnerActivitySource, runnerRunsChannel } from './runnersStore.ts';

/**
 * This package's cockpit presence. The runner channel is authoritative for the
 * dock as well as its section, so a dropped footer projection cannot hide work
 * the hub is already reporting.
 */
export const webPlugin = defineWebPlugin({
  id: 'runner',
  channels: [runnerRunsChannel],
  activityGroups: [
    {
      name: 'runners',
      keys: 'r l',
      statusKey: 'doom-runner-runners',
      activeSource: runnerActivitySource,
      order: 20,
    },
  ],
  // Same name as the group: the dock renders this inside it, in place of the
  // footer's one-line count.
  activitySections: [{ id: 'runners', component: RunnersActivitySection }],
  // The bash tool's timeline card, the web half of src/tui/bashRender.ts.
  toolRenderers: [{ tools: ['bash'], message: BashToolMessage }],
});
