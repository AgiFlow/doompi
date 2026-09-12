import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { BashToolMessage } from './components/BashToolMessage.tsx';
import { RunnersActivitySection } from './components/RunnersActivitySection.tsx';
import { runnersTab } from './components/RunnersPanel.tsx';
import { runnerActivitySource, runnerRunsChannel } from './stores/runnersStore.ts';

/**
 * This package's cockpit presence. The runner channel is authoritative for the
 * dock as well as its section, so a dropped footer projection cannot hide work
 * the hub is already reporting.
 */
export const webPlugin = defineWebPlugin({
  id: 'runner',
  session: {
    channels: [runnerRunsChannel],
    activityGroups: [
      {
        name: 'runners',
        keys: 'r l',
        statusKey: 'doom-runner-runners',
        activeSource: runnerActivitySource,
        // The group's own name opens the fleet. The rail gives a runner one
        // line, which is enough to notice it and not enough to work with it.
        transientTab: runnersTab,
        order: 20,
      },
    ],
    // Same name as the group: the dock renders this inside it, in place of the
    // footer's one-line count.
    activitySections: [{ id: 'runners', component: RunnersActivitySection }],
    // The bash tool's timeline card, the web half of src/tui/bashRender.ts.
    toolRenderers: [{ tools: ['bash'], message: BashToolMessage }],
  },
});
