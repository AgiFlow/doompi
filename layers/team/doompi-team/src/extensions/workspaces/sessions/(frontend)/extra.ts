import { subagentsTab } from '../../../../web/components/SubagentsPanel';
import { openCatalog } from '../../../../web/stores/catalogStore';
import { activityRuns, isTerminalRun, subagents } from '../../../../web/stores/subagentsStore';

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

/**
 * The two surfaces with no folder of their own.
 *
 * An activity group is a region other plugins fill, and a leader binding is a
 * key path into this one. Neither is a contribution the path can name, so both
 * come through the hatch. The section that renders inside the group is a
 * routed fill, because that one does have a target to name.
 */
export default {
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
      run: (context: { openTransientTab: (tab: ReturnType<typeof subagentsTab>) => void }) =>
        context.openTransientTab(subagentsTab()),
    },
    {
      id: 'subagents.catalog',
      path: [AGENTS_GROUP, { key: 'l', label: 'launch', detail: 'pick an agent and launch it' }],
      run: (context: {
        sessionId: string | null;
        openTransientTab: (tab: ReturnType<typeof subagentsTab>) => void;
      }) => {
        if (context.sessionId !== null) openCatalog(context.sessionId);
        context.openTransientTab(subagentsTab());
      },
    },
  ],
};
