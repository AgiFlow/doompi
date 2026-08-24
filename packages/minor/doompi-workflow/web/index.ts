import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { WorkflowsActivitySection } from './WorkflowsActivitySection.tsx';
import { WorkflowsPanel } from './WorkflowsPanel.tsx';
import { WorkflowCall, WorkflowResult } from './WorkflowToolCard.tsx';
import { workflowRunsChannel, workflowsStore } from './workflowsStore.ts';

/** The tab badge: only runs still in the running stage. */
export function useWorkflowsBadge(sessionId: string | null): number {
  return useStore(workflowsStore, (state) =>
    sessionId === null ? 0 : (state.bySession[sessionId]?.filter((run) => run.stage === 'running').length ?? 0),
  );
}

const WORKFLOWS_GROUP = { key: 'w', label: 'workflows', detail: 'multi-step agent runs' };

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'workflows',
  tabs: [{ id: 'workflows', label: 'workflows', panel: WorkflowsPanel, useBadge: useWorkflowsBadge }],
  channels: [workflowRunsChannel],
  minorModes: [{ name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress', order: 50 }],
  activityGroups: [
    {
      name: 'workflows',
      keys: 'w r',
      widgetKeys: ['workflow-mcp-progress', 'workflow-mcp-follow'],
      tab: 'workflows',
      order: 30,
    },
  ],
  // Same name as the group: the dock renders this inside it, in place of the
  // widget's bare presence signal.
  activitySections: [{ id: 'workflows', component: WorkflowsActivitySection }],
  // The workflow tools' timeline cards, the web half of src/tui/workflow/workflowToolRender.ts.
  toolRenderers: [
    { tools: ['list_workflows', 'launch_workflow', 'workflow_run'], call: WorkflowCall, result: WorkflowResult },
  ],
  // The TUI's SPC w r and SPC w e; the catalog (w l) and recovery (w c) are
  // TUI-only overlays, so they have no cockpit key yet.
  leaderBindings: [
    {
      id: 'doom-workflow.manage',
      path: [WORKFLOWS_GROUP, { key: 'r', label: 'runs', detail: 'runs in this session' }],
      run: (context) => context.openTab('workflows'),
    },
    {
      id: 'doom-workflow.toggle',
      path: [WORKFLOWS_GROUP, { key: 'e', label: 'toggle', detail: 'give the agent workflow tools or take them back' }],
      command: 'minor workflow',
    },
  ],
});
