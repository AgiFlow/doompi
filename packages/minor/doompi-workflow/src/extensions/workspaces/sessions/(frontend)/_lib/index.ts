import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { WorkflowsActivitySection } from '../fill/_components/WorkflowsActivitySection';
import { WorkflowToolMessage } from '../tool/_components/WorkflowToolMessage';
import { openCatalog, openWorkflowCatalogForContext, workflowCatalogChannel } from './catalogStore';
import { workflowRunsChannel, workflows } from './workflowsStore';
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

export default {
  // No tab: a run lives in its own workflow session, whose dock shows it, and
  // the catalog opens over whatever the session shows.
  channels: [workflowRunsChannel, workflowCatalogChannel],
  contextActions: [
    {
      id: 'launch-workflow',
      label: 'Launch Workflow',
      detail: 'Choose a workflow, review its inputs, then launch it.',
      kinds: ['work-item'],
      order: 20,
      run: (context) => openWorkflowCatalogForContext(context),
    },
  ],
  minorModes: [{ name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress', order: 50 }],
  activityGroups: [
    {
      name: 'workflows',
      keys: 'w r',
      widgetKeys: ['workflow-mcp-progress', 'workflow-mcp-follow'],
      activeSource: workflowActivitySource,
      order: 30,
    },
  ],
  // Same name as the group: the dock renders this inside it, in place of the
  // widget's bare presence signal.
  activitySections: [{ id: 'workflows', component: WorkflowsActivitySection }],
  // The workflow tools' timeline cards, the web half of src/tui/workflow/workflowToolRender.ts.
  toolRenderers: [
    { tools: ['list_workflows', 'launch_workflow', 'workflow_run', 'workflow_tools'], message: WorkflowToolMessage },
  ],
  // The TUI's SPC w l and w e. SPC w r opened the old runs tab, which a run's
  // workflow session and its dock face replace; recovery (w c) is TUI-only.
  leaderBindings: [
    {
      id: 'doom-workflow.catalog',
      path: [WORKFLOWS_GROUP, { key: 'l', label: 'launch', detail: 'pick a workflow and launch it' }],
      run: (context) => {
        if (context.sessionId !== null) openCatalog(context.sessionId);
      },
    },
    {
      id: 'doom-workflow.toggle',
      path: [WORKFLOWS_GROUP, { key: 'e', label: 'toggle', detail: 'give the agent workflow tools or take them back' }],
      command: 'minor workflow',
    },
  ],
} satisfies NonNullable<WebPluginDefinition['session']>;
