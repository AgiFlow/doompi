import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { AgentsActivitySection } from './AgentsActivitySection.tsx';
import { SubagentsPanel } from './SubagentsPanel.tsx';
import { bindSubagentsRuntime, subagentRunsChannel, subagentsStore, visibleRuns } from './subagentsStore.ts';

/** The tab badge: every run the session's fleet currently shows. */
export function useSubagentsBadge(sessionId: string | null): number {
  return useStore(subagentsStore, (state) => visibleRuns(state, sessionId).length);
}

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'subagents',
  tabs: [{ id: 'subagents', label: 'subagents', panel: SubagentsPanel, useBadge: useSubagentsBadge }],
  channels: [subagentRunsChannel],
  activityGroups: [{ name: 'agents', keys: 'a r', statusKey: 'doom-team-agents', order: 10 }],
  // Same name as the group: the dock renders this inside it, in place of the
  // footer's one-line summary.
  activitySections: [{ id: 'agents', component: AgentsActivitySection }],
  start: bindSubagentsRuntime,
});
