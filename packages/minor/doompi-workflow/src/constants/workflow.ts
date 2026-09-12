export const COMMAND_DESCRIPTION = 'Doom Pi workflow execution and monitoring integration';
export const PACKAGE_SOURCE = '@agimon-ai/doompi-workflow';

export const LEADER_KEY = 'w';
export const LEADER_LABEL = 'workflows';
export const LEADER_ORDER = 50;
export const LEADER_ENABLE_ACTION = 'workflow.enable';
export const LEADER_DISABLE_ACTION = 'workflow.disable';
export const LEADER_MANAGE_ACTION = 'workflow.manage';
export const LEADER_RECOVER_ACTION = 'workflow.recover';
export const LEADER_CATALOG_ACTION = 'workflow.catalog';
export const LEADER_DETAIL = 'multi-step agent runs';

export const LIST_WORKFLOWS_TOOL_NAME = 'list_workflows';
export const LAUNCH_WORKFLOW_TOOL_NAME = 'launch_workflow';
export const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';
export const WORKFLOW_PI_TOOL_NAMES = [
  LIST_WORKFLOWS_TOOL_NAME,
  LAUNCH_WORKFLOW_TOOL_NAME,
  WORKFLOW_RUN_TOOL_NAME,
] as const;
