import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { SubagentsPanel } from './SubagentsPanel.tsx';
import { subagentRunsChannel, subagentsStore } from './subagentsStore.ts';

/** The tab badge: every run the session's fleet currently shows. */
export function useSubagentsBadge(sessionId: string | null): number {
  return useStore(subagentsStore, (state) => (sessionId === null ? 0 : (state.bySession[sessionId]?.length ?? 0)));
}

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'subagents',
  tabs: [{ id: 'subagents', label: 'subagents', panel: SubagentsPanel, useBadge: useSubagentsBadge }],
  channels: [subagentRunsChannel],
  activityGroups: [{ name: 'agents', keys: 'a r', statusKey: 'doom-team-agents', order: 10 }],
});
