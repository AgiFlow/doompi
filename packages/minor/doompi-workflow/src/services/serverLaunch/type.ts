import type { EmbeddedWorkflowFeature, RecoverWorkflowToolOptions } from '@agimon-ai/workflow-mcp';
import type { CallToolResult } from '@modelcontextprotocol/server';

import type { StepTelemetry } from '../stepExecutor/type';
import type { WorkflowLaunchInput } from '../workflowExecution';

export type ServerNoticeLevel = 'info' | 'warning' | 'error';

export interface ServerLaunchDependencies {
  readonly feature: Pick<EmbeddedWorkflowFeature, 'createRunService' | 'registry'>;
  /** The session launching, which owns its runs. */
  readonly createRecoverTool: (
    options: RecoverWorkflowToolOptions,
  ) => Pick<ReturnType<EmbeddedWorkflowFeature['createRecoverTool']>, 'execute'>;
  readonly sessionId: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly telemetry?: StepTelemetry;
  /** Tells the session about a run that failed after its launch had answered. */
  readonly notify: (body: string, level: ServerNoticeLevel) => void | Promise<void>;
  /** Why a runner cannot run a workflow, or undefined when it can. */
  readonly rejectRunner?: (workflowPath: string, runner: string) => string | undefined;
  /** The session's run list changed: a run registered, or one ended. */
  readonly onRunsChanged?: () => void;
  /** How long closing the session waits for its runs to stop. */
  readonly stopTimeoutMs?: number;
  readonly launchAckPollMs?: number;
  readonly launchAckTimeoutMs?: number;
}

export interface ServerLauncher {
  /** Runs a workflow in this process, answering once it registers. Throws what the launch refuses. */
  launch(input: WorkflowLaunchInput): Promise<CallToolResult>;
  /** Runs this launcher started that have not ended. */
  recover(
    target: { runKey: string; workspace: string },
    options: { dryRun?: boolean; runner?: string },
  ): Promise<CallToolResult>;
  activeRunCount(): number;
  /** Asks every run still going to stop, and waits a bounded time for them. */
  dispose(): Promise<void>;
}
