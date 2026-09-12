import { resolveRootSessionId } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { DoomToolRestriction } from '@agimon-ai/doompi-extension-contracts/tool-surface';
import { type EmbeddedWorkflowFeature, type WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type WorkflowRunInput } from '../../schemas/workflowPi';
import {
  launchedRunSummary,
  launchHandoffSummary,
  PI_SESSION_ENV,
  resolveMaxConcurrent,
  toolResultText,
  withOptions,
} from '../piToolBridge';

const AGIFLOW_JOB_ID_ENV = 'AGIFLOW_JOB_ID';
const AGIFLOW_JOB_KIND_ENV = 'AGIFLOW_JOB_KIND';
const AGIFLOW_PROJECT_ID_ENV = 'AGIFLOW_PROJECT_ID';

import { WORKFLOW_PI_TOOL_NAMES, LAUNCH_WORKFLOW_TOOL_NAME } from '../../constants/workflow';

/**
 * What workflow mode does to the tool surface: nothing but hide its own tools.
 *
 * The tools are registered for the whole session because Pi has no other way to
 * add one later, so the mode is expressed as a restriction rather than as a
 * registration.
 */
export function workflowToolRestriction(enabled: boolean): DoomToolRestriction {
  const hidden = new Set<string>(WORKFLOW_PI_TOOL_NAMES);
  return (incoming) => (enabled ? incoming : incoming.filter((name) => !hidden.has(name)));
}

export type WorkflowRunSelector = Pick<WorkflowRunInput, 'runKey' | 'workspace'>;

export type WorkflowLaunchInput = z.infer<ReturnType<EmbeddedWorkflowFeature['runTool']['getInputSchema']>>;

/**
 * Where a launch was answered from, which decides what the caller is told.
 *
 * Tagged rather than inferred from an absent field: the failure carries an
 * `unknown`, and `unknown` includes `undefined`, so only a tag can tell a
 * rejection apart from a result.
 */
type LaunchOutcome = { kind: 'value'; result: CallToolResult } | { kind: 'error'; error: unknown };
type LaunchAck =
  | { kind: 'settled'; outcome: LaunchOutcome }
  | { kind: 'record'; record: WorkflowRunRecord }
  | { kind: 'handoff' };

/** How often the registry is asked whether the launch has produced a run. */
const LAUNCH_ACK_POLL_MS = 500;
/**
 * How long to wait for that before answering without a run key.
 *
 * Long enough to cover a launcher that is merely slow, short enough that a
 * caller is never left holding a turn open for a launcher that will not answer.
 */
const LAUNCH_ACK_TIMEOUT_MS = 15_000;

export interface LaunchedRunQuery {
  sessionId: string | undefined;
  /** Epoch milliseconds the launch began, so an earlier run cannot match. */
  since: number;
  workflowPath: string;
}

export interface WorkflowLaunchExecutorDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  activeRunCount?: () => Promise<number>;
  onLaunch?: (ctx: ExtensionContext) => Promise<void> | void;
  observeSession?: (sessionId: string | undefined) => void;
  rejectRunner?: (workflowPath: string, runner: string) => string | undefined;
  runTool: EmbeddedWorkflowFeature['runTool'];
  trackPendingRun: <T>(run: Promise<T>) => Promise<T>;
  /**
   * The run this launch registered, or undefined while none has appeared.
   *
   * Its presence is what lets a launch answer on the registry instead of on the
   * launcher process exiting. Left out, the launch waits for the process, which
   * is the behaviour every caller had before.
   */
  findLaunchedRun?: (query: LaunchedRunQuery) => Promise<WorkflowRunRecord | undefined>;
  /** Report a launch that fails after this call already answered "started". */
  onLateFailure?: (error: unknown, ctx: ExtensionContext) => void;
  launchAckPollMs?: number;
  launchAckTimeoutMs?: number;
}

export interface WorkflowLaunchExecutor {
  execute(
    input: WorkflowLaunchInput,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<{ tool: string }>,
  ): Promise<CallToolResult>;
}

export interface WorkflowPiToolDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  launchExecutor?: WorkflowLaunchExecutor;
  onLaunch?: (ctx: ExtensionContext) => Promise<void> | void;
  activeRunCount?: () => Promise<number>;
  followRun?: (input: WorkflowRunSelector, ctx: ExtensionContext) => Promise<string>;
  tailRun?: (input: WorkflowRunSelector, ctx: ExtensionContext) => Promise<string>;
  openRun?: (input: WorkflowRunSelector, ctx: ExtensionContext) => Promise<string>;
  rejectRunner?: (workflowPath: string, runner: string) => string | undefined;
  requireSessionRun?: (input: WorkflowRunSelector, sessionId: string | undefined) => Promise<WorkflowRunRecord>;
  /**
   * Resolve a failed recovery target globally.
   *
   * Recovery is the one ownership-transferring action: a replacement Pi
   * session must be able to adopt a terminal run whose launching session is
   * gone. Every non-recovery action remains session-scoped.
   */
  requireRecoverableRun?: (input: WorkflowRunSelector) => Promise<WorkflowRunRecord>;
  readRecoveryEvidence?: (input: WorkflowRunSelector, ctx: ExtensionContext) => Promise<string>;
  /**
   * Hand a recovery to a terminal launcher, returning what to tell the caller.
   *
   * Undefined means this recovery cannot be delegated, and the in-process
   * replay below is used instead.
   */
  delegateRecovery?: (
    input: { runKey: string; workspace?: string; runner?: string },
    ctx: ExtensionContext,
  ) => Promise<string | undefined>;
  observeSession?: (sessionId: string | undefined) => void;
  trackPendingRun?: <T>(run: Promise<T>) => Promise<T>;
  feature?: EmbeddedWorkflowFeature;
  recoverTool?: {
    execute(input: {
      dryRun?: boolean;
      job?: string;
      runKey: string;
      runner?: string;
      workspace?: string;
    }): Promise<CallToolResult>;
  };
  controlTool?: ReturnType<EmbeddedWorkflowFeature['createControlTool']>;
  runTool?: EmbeddedWorkflowFeature['runTool'];
  listWorkflowsTool?: EmbeddedWorkflowFeature['listWorkflowsTool'];
}

export function reportProgress(
  onUpdate: AgentToolUpdateCallback<{ tool: string }> | undefined,
  tool: string,
  message: string,
): void {
  onUpdate?.({ content: [{ type: 'text', text: message }], details: { tool } });
}

export function appendGuidance(
  result: AgentToolResult<{ tool: string }>,
  guidance: string,
): AgentToolResult<{ tool: string }> {
  return { ...result, content: [...result.content, { type: 'text', text: guidance }] };
}

function statusAction(runKey: string): string {
  return `workflow_run {"action":"status","runKey":${JSON.stringify(runKey)}}`;
}

export function actionGuidance(action: WorkflowRunInput['action'], runKey: string): string[] {
  const status = statusAction(runKey);
  if (action === 'stop') return [`Next: call ${status} to confirm the run reached a terminal stage.`];
  if (action === 'recover') {
    return [
      `Report the recovery failure and do not retry it blindly: call ${status} first.`,
      'Ask the user before launching fresh work when the recorded recovery is no longer valid.',
    ];
  }
  return [`Next: call ${status} to verify the recorded execution state.`];
}

export const launchFailureOptions = [
  'Report the failure to the user with the error above. A launch failure is usually a bad workflow path, a missing launcher, or a workflow whose own pre-conditions refused.',
  'list_workflows: confirm the workflow path exists and its description matches the work, if the path may be wrong.',
  'workflow_run with action status: check whether an earlier attempt is already running before launching again.',
];

/**
 * An Error, whatever the launch rejected with.
 *
 * A rejection reaches here as `unknown` because it crossed a promise boundary,
 * and rethrowing that as-is hands Pi's tool layer something it cannot read a
 * message or a stack off. The original is kept as the cause rather than
 * flattened into a string.
 */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value), { cause: value });
}

/** Resolves to undefined, so a race against it reads as "nothing settled yet". */
function sleep(ms: number): Promise<undefined> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(undefined), ms);
    timer.unref?.();
  });
}

/**
 * Wait for whichever answer arrives first: the launch settling, the run
 * appearing in the registry, or the budget running out.
 *
 * A launch that delegates to a terminal launcher settles when that launcher's
 * whole process chain closes, which on a loaded machine has been measured
 * minutes after the run itself was registered and working. The registry is the
 * earlier and more truthful signal: a run recorded there is a run that started.
 */
async function awaitLaunchAck(
  settled: Promise<LaunchOutcome>,
  dependencies: WorkflowLaunchExecutorDependencies,
  query: LaunchedRunQuery,
): Promise<LaunchAck> {
  const findLaunchedRun = dependencies.findLaunchedRun;
  if (!findLaunchedRun) return { kind: 'settled', outcome: await settled };

  const pollMs = dependencies.launchAckPollMs ?? LAUNCH_ACK_POLL_MS;
  const deadline = Date.now() + (dependencies.launchAckTimeoutMs ?? LAUNCH_ACK_TIMEOUT_MS);
  for (;;) {
    const outcome = await Promise.race([settled, sleep(pollMs)]);
    if (outcome) return { kind: 'settled', outcome };
    // A registry read that throws must not fail the launch: the run may be
    // perfectly healthy, and the settled promise is still the fallback.
    const record = await findLaunchedRun(query).catch(() => undefined);
    if (record) return { kind: 'record', record };
    if (Date.now() >= deadline) return { kind: 'handoff' };
  }
}

/**
 * Carry a failure that lands after the caller was told the run started.
 *
 * Answering early trades the launcher's exit code for timeliness. Dropping that
 * code entirely is not part of the trade: a launch that fails a minute later
 * would otherwise leave a user waiting on a run that never existed.
 */
function reportLateFailure(
  settled: Promise<LaunchOutcome>,
  dependencies: WorkflowLaunchExecutorDependencies,
  ctx: ExtensionContext,
): void {
  void settled.then((outcome) => {
    if (outcome.kind === 'error') {
      dependencies.onLateFailure?.(asError(outcome.error), ctx);
      return;
    }
    if (outcome.result.isError) {
      dependencies.onLateFailure?.(new Error(toolResultText(outcome.result) || 'Workflow launch failed.'), ctx);
    }
  });
}

export function createWorkflowLaunchExecutor(dependencies: WorkflowLaunchExecutorDependencies): WorkflowLaunchExecutor {
  return {
    async execute(input, ctx, onUpdate) {
      const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId(), dependencies.environment);
      dependencies.observeSession?.(sessionId);
      const agiflowJobKind = input.env?.[AGIFLOW_JOB_KIND_ENV]?.trim();
      const agiflowJobId = input.env?.[AGIFLOW_JOB_ID_ENV]?.trim();
      const explicitProjectId = input.env?.[AGIFLOW_PROJECT_ID_ENV]?.trim();
      if (Boolean(agiflowJobKind) !== Boolean(agiflowJobId)) {
        throw new Error('Agiflow workflow launches require AGIFLOW_JOB_KIND and AGIFLOW_JOB_ID together.');
      }
      if (agiflowJobKind && agiflowJobKind !== 'task' && agiflowJobKind !== 'work-unit') {
        throw new Error('Agiflow workflow launches require AGIFLOW_JOB_KIND to be task or work-unit.');
      }
      if (agiflowJobKind && !explicitProjectId) {
        throw new Error('Agiflow workflow launches require AGIFLOW_PROJECT_ID with the job identity.');
      }
      if (agiflowJobKind && !input.prompt?.trim()) {
        throw new Error(
          'Agiflow workflow launches require a non-empty prompt so user_prompt runs do not wait for terminal input.',
        );
      }
      reportProgress(onUpdate, LAUNCH_WORKFLOW_TOOL_NAME, 'Checking workflow capacity...');
      const maxConcurrent = resolveMaxConcurrent(dependencies.environment);
      const active = (await dependencies.activeRunCount?.()) ?? 0;
      if (active >= maxConcurrent) {
        throw new Error(
          withOptions(`This session is at capacity: ${active}/${maxConcurrent} workflows running.`, [
            'Wait for a running workflow to finish, then launch again. The extension reports each one as it ends.',
            'workflow_run with action status: show what is running, so the user can judge whether something is stuck.',
            'workflow_run with action stop: free a slot by stopping a run the user no longer wants.',
          ]),
        );
      }

      if (input.runner) {
        const rejection = dependencies.rejectRunner?.(input.workflowPath, input.runner);
        if (rejection) throw new Error(rejection);
      }
      reportProgress(onUpdate, LAUNCH_WORKFLOW_TOOL_NAME, `Launching workflow ${input.workflowPath}...`);
      const workflowEnv = { ...input.env };
      const dispatcherContextFile = dependencies.environment.AGIFLOW_DISPATCH_CONTEXT_FILE;
      const dispatcherProjectId = dependencies.environment[AGIFLOW_PROJECT_ID_ENV]?.trim();
      if (
        dispatcherContextFile &&
        agiflowJobKind &&
        dispatcherProjectId &&
        explicitProjectId &&
        dispatcherProjectId !== explicitProjectId
      ) {
        throw new Error(
          `Agiflow workflow project identity conflicts with the dispatcher context (${explicitProjectId} versus ${dispatcherProjectId}).`,
        );
      }
      if (dispatcherContextFile) {
        for (const key of [
          'AGIFLOW_ORGANIZATION_ID',
          'AGIFLOW_PROJECT_ID',
          'AGIFLOW_DEVICE_ID',
          'BACKEND_AGIFLOW_API_ENDPOINT',
          'AGIFLOW_DISPATCH_SECRET_FILE',
        ] as const) {
          const hostValue = dependencies.environment[key];
          if (hostValue) workflowEnv[key] = hostValue;
        }
      }
      const since = Date.now();
      const launch = dependencies.trackPendingRun(
        dependencies.runTool.execute({
          ...input,
          env: { ...workflowEnv, [PI_SESSION_ENV]: sessionId },
        }),
      );
      // Folded into a value before anything races it. A promise this function
      // may stop awaiting must never be able to reject unobserved, which in
      // Node ends the whole process, Pi's TUI included.
      const settled: Promise<LaunchOutcome> = launch.then(
        (value): LaunchOutcome => ({ kind: 'value', result: value }),
        (error: unknown): LaunchOutcome => ({ kind: 'error', error }),
      );

      const ack = await awaitLaunchAck(settled, dependencies, {
        sessionId,
        since,
        workflowPath: input.workflowPath,
      });

      if (ack.kind === 'settled') {
        const outcome = ack.outcome;
        if (outcome.kind === 'error') throw asError(outcome.error);
        const result = outcome.result;
        if (result.isError)
          throw new Error(withOptions(toolResultText(result) || 'Workflow launch failed.', launchFailureOptions));
        await dependencies.onLaunch?.(ctx);
        return result;
      }

      reportLateFailure(settled, dependencies, ctx);
      await dependencies.onLaunch?.(ctx);
      return {
        content: [
          {
            type: 'text',
            text: ack.kind === 'record' ? launchedRunSummary(ack.record) : launchHandoffSummary(input.workflowPath),
          },
        ],
      };
    },
  };
}
