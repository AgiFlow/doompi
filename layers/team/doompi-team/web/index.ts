import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { AgentsActivitySection } from './AgentsActivitySection.tsx';
import { SubagentsPanel } from './SubagentsPanel.tsx';
import { bindSubagentsRuntime, subagentRunsChannel, subagentsStore, visibleRuns } from './subagentsStore.ts';
import { teamToolRenderers } from './toolRenderers.ts';

/** The tab badge: every run the session's fleet currently shows. */
export function useSubagentsBadge(sessionId: string | null): number {
  return useStore(subagentsStore, (state) => visibleRuns(state, sessionId).length);
}

const AGENTS_GROUP = { key: 'a', label: 'agents', detail: 'subagent resources and runs' };

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'subagents',
  tabs: [{ id: 'subagents', label: 'subagents', panel: SubagentsPanel, useBadge: useSubagentsBadge }],
  channels: [subagentRunsChannel],
  activityGroups: [{ name: 'agents', keys: 'a r', statusKey: 'doom-team-agents', tab: 'subagents', order: 10 }],
  // The TUI's SPC a r; SPC a l opens a TUI-only catalog overlay, so it has no cockpit key yet.
  leaderBindings: [
    {
      id: 'subagents.fleet',
      path: [AGENTS_GROUP, { key: 'r', label: 'runs', detail: 'runs in this session' }],
      run: (context) => context.openTab('subagents'),
    },
  ],
  // Same name as the group: the dock renders this inside it, in place of the
  // footer's one-line summary.
  activitySections: [{ id: 'agents', component: AgentsActivitySection }],
  toolRenderers: teamToolRenderers,
  start: bindSubagentsRuntime,
});
