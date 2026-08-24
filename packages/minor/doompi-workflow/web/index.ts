import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { WorkflowsPanel } from './WorkflowsPanel.tsx';
import { workflowRunsChannel, workflowsStore } from './workflowsStore.ts';

/** The tab badge: only runs still in the running stage. */
export function useWorkflowsBadge(sessionId: string | null): number {
  return useStore(workflowsStore, (state) =>
    sessionId === null ? 0 : (state.bySession[sessionId]?.filter((run) => run.stage === 'running').length ?? 0),
  );
}

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'workflows',
  tabs: [{ id: 'workflows', label: 'workflows', panel: WorkflowsPanel, useBadge: useWorkflowsBadge }],
  channels: [workflowRunsChannel],
  minorModes: [{ name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress', order: 50 }],
});
