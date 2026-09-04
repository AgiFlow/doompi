import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { openCatalog, openWorkflowCatalogForContext, workflowCatalogChannel } from './catalogStore.ts';
import { WorkflowsActivitySection } from './WorkflowsActivitySection.tsx';
import { workflowsTab } from './WorkflowsPanel.tsx';
import { WorkflowToolMessage } from './WorkflowToolMessage.tsx';
import { workflowRunsChannel, workflows } from './workflowsStore.ts';

const WORKFLOWS_GROUP = { key: 'w', label: 'workflows', detail: 'multi-step agent runs' };

const workflowActivitySource = {
  subscribe(listener: () => void) {
    const subscription = workflows.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  isActive(sessionId: string | null) {
    return workflows.select(workflows.store.state, sessionId).runs.some((run) => run.stage === 'running');
  },
};

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'workflows',
  // No declared tab: the runs surface is a panel the reader opens from the
  // dock's workflows group, and closes when they are done with it.
  channels: [workflowRunsChannel, workflowCatalogChannel],
  contextActions: [
    {
      id: 'launch-workflow',
      label: 'Launch Workflow',
      detail: 'Choose a workflow, review its inputs, then launch it.',
      kinds: ['work-item'],
      order: 20,
      run: (context) => openWorkflowCatalogForContext(context, workflowsTab),
    },
  ],
  minorModes: [{ name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress', order: 50 }],
  activityGroups: [
    {
      name: 'workflows',
      keys: 'w r',
      widgetKeys: ['workflow-mcp-progress', 'workflow-mcp-follow'],
      activeSource: workflowActivitySource,
      transientTab: workflowsTab,
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
      run: (context) => context.openTransientTab(workflowsTab()),
    },
    {
      id: 'doom-workflow.catalog',
      path: [WORKFLOWS_GROUP, { key: 'l', label: 'launch', detail: 'pick a workflow and launch it' }],
      run: (context) => {
        if (context.sessionId !== null) openCatalog(context.sessionId);
        context.openTransientTab(workflowsTab());
      },
    },
    {
      id: 'doom-workflow.toggle',
      path: [WORKFLOWS_GROUP, { key: 'e', label: 'toggle', detail: 'give the agent workflow tools or take them back' }],
      command: 'minor workflow',
    },
  ],
});
