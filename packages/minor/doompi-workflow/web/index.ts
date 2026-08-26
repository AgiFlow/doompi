import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { openCatalog, workflowCatalogChannel } from './catalogStore.ts';
import { WorkflowsActivitySection } from './WorkflowsActivitySection.tsx';
import { WorkflowsPanel } from './WorkflowsPanel.tsx';
import { WorkflowToolMessage } from './WorkflowToolMessage.tsx';
import { workflowRunsChannel, workflows } from './workflowsStore.ts';

/** The tab badge: only runs still in the running stage. */
export function useWorkflowsBadge(sessionId: string | null): number {
  return useStore(
    workflows.store,
    (state) => workflows.select(state, sessionId).runs.filter((run) => run.stage === 'running').length,
  );
}

const WORKFLOWS_GROUP = { key: 'w', label: 'workflows', detail: 'multi-step agent runs' };

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'workflows',
  tabs: [{ id: 'workflows', label: 'workflows', panel: WorkflowsPanel, useBadge: useWorkflowsBadge }],
  channels: [workflowRunsChannel, workflowCatalogChannel],
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
  toolRenderers: [{ tools: ['list_workflows', 'launch_workflow', 'workflow_run'], message: WorkflowToolMessage }],
  // The TUI's SPC w r, w l and w e; recovery (w c) is a TUI-only overlay, so
  // it has no cockpit key yet.
  leaderBindings: [
    {
      id: 'doom-workflow.manage',
      path: [WORKFLOWS_GROUP, { key: 'r', label: 'runs', detail: 'runs in this session' }],
      run: (context) => context.openTab('workflows'),
    },
    {
      id: 'doom-workflow.catalog',
      path: [WORKFLOWS_GROUP, { key: 'l', label: 'launch', detail: 'pick a workflow and launch it' }],
      run: (context) => {
        if (context.sessionId !== null) openCatalog(context.sessionId);
        context.openTab('workflows');
      },
    },
    {
      id: 'doom-workflow.toggle',
      path: [WORKFLOWS_GROUP, { key: 'e', label: 'toggle', detail: 'give the agent workflow tools or take them back' }],
      command: 'minor workflow',
    },
  ],
});
