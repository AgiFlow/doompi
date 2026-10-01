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
export const WORKFLOW_TOOLS_TOOL_NAME = 'workflow_tools';
export const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';
export const WORKFLOW_PI_TOOL_NAMES = [
  LIST_WORKFLOWS_TOOL_NAME,
  LAUNCH_WORKFLOW_TOOL_NAME,
  WORKFLOW_RUN_TOOL_NAME,
] as const;

/**
 * One launch's own id, carried in the run's environment.
 *
 * A launch answers once its run registers; matching on this id, rather than on
 * the workflow and the time, keeps two launches of one workflow apart.
 */
export const WORKFLOW_LAUNCH_ID_ENV = 'DOOMPI_WORKFLOW_LAUNCH_ID';

/**
 * Provenance of the child session a launch creates to own and run one workflow.
 * Not 'workflow', which marks a step's session and keeps it out of the rail.
 */
export const WORKFLOW_SESSION_PROVENANCE = 'workflow-session';

/**
 * Run env key naming the session that launched a run into its own workflow
 * session. PI_SESSION_ID names the owner; this names the launcher, which lists
 * the run, is told when it ends, and releases the workflow session after success.
 */
export const WORKFLOW_LAUNCHER_SESSION_ENV = 'DOOMPI_WORKFLOW_LAUNCHER_SESSION_ID';

/** Message a workflow session sends its launcher to be released once its run succeeded. */
export const WORKFLOW_SESSION_RELEASE_TYPE = 'doompi-workflow.session-release';
