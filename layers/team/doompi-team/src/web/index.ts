import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { AgentsActivitySection } from './AgentsActivitySection.tsx';
import { subagentsTab } from './SubagentsPanel.tsx';
import { openAgentCatalogForContext, openCatalog, subagentCatalogChannel } from './catalogStore.ts';
import { RUN_ACTIONS_SLOT } from './runActionsSlot.ts';
import { activityRuns, isTerminalRun, subagentRunsChannel, subagents } from './subagentsStore.ts';
import { teamToolRenderers } from './toolRenderers.ts';

const AGENTS_GROUP = { key: 'a', label: 'agents', detail: 'subagent resources and runs' };

// The group is the only way into the fleet now, so it stays visible while the
// session is idle: a launcher that appears only once something runs cannot be
// used to start anything.
const agentsActivitySource = {
  subscribe(listener: () => void) {
    const subscription = subagents.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  isActive(sessionId: string | null) {
    return activityRuns(subagents.select(subagents.store.state, sessionId)).some((run) => !isTerminalRun(run));
  },
};

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'subagents',
  channels: [subagentRunsChannel, subagentCatalogChannel],
  contextActions: [
    {
      id: 'launch-agent',
      label: 'Launch Agent',
      detail: 'Choose an agent, review the task, then launch it.',
      kinds: ['work-item'],
      order: 10,
      run: (context) => openAgentCatalogForContext(context, subagentsTab),
    },
  ],
  // No declared tab: the fleet is a panel the reader opens from the dock's
  // agents group, and closes when they are done with it.
  activityGroups: [
    {
      name: 'agents',
      keys: 'a r',
      statusKey: 'doom-team-agents',
      activeSource: agentsActivitySource,
      transientTab: subagentsTab,
      order: 10,
    },
  ],
  // The TUI's SPC a r and SPC a l: the runs, and the catalog to launch from.
  leaderBindings: [
    {
      id: 'subagents.fleet',
      path: [AGENTS_GROUP, { key: 'r', label: 'runs', detail: 'runs in this session' }],
      run: (context) => context.openTransientTab(subagentsTab()),
    },
    {
      id: 'subagents.catalog',
      path: [AGENTS_GROUP, { key: 'l', label: 'launch', detail: 'pick an agent and launch it' }],
      run: (context) => {
        if (context.sessionId !== null) openCatalog(context.sessionId);
        context.openTransientTab(subagentsTab());
      },
    },
  ],
  // Same name as the group: the dock renders this inside it, in place of the
  // footer's one-line summary.
  activitySections: [{ id: 'agents', component: AgentsActivitySection }],
  toolRenderers: teamToolRenderers,
  // The run detail sheet's action row is open to independent plugins.
  slots: [RUN_ACTIONS_SLOT],
});
