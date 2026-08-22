import { resolveRootSessionId } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  createEmbeddedWorkflowFeature,
  type EmbeddedWorkflowFeature,
  type WorkflowRunRecord,
} from '@agimon-ai/workflow-mcp';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type WorkflowRunInput, workflowRunInputSchema } from '../../../schemas/workflowPi.ts';
import { renderWorkflowToolCall, renderWorkflowToolResult } from '../../../tui/workflow/workflowToolRender.ts';
import {
  launchedRunSummary,
  launchHandoffSummary,
  PI_SESSION_ENV,
  resolveMaxConcurrent,
  toAgentToolResult,
  toolResultText,
  withOptions,
} from './piToolBridge';

const AGIFLOW_JOB_ID_ENV = 'AGIFLOW_JOB_ID';
const AGIFLOW_JOB_KIND_ENV = 'AGIFLOW_JOB_KIND';

const PI_LAUNCH_FIELDS = {
  workflowPath: true,
  workspace: true,
  runner: true,
  name: true,
  env: true,
  prompt: true,
  job: true,
  inputs: true,
} as const;

export const WORKFLOW_PI_TOOL_NAMES = ['list_workflows', 'launch_workflow', 'workflow_run'] as const;
const [LIST_WORKFLOWS_TOOL_NAME, LAUNCH_WORKFLOW_TOOL_NAME, WORKFLOW_RUN_TOOL_NAME] = WORKFLOW_PI_TOOL_NAMES;

type WorkflowRunSelector = Pick<WorkflowRunInput, 'runKey' | 'workspace'>;

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

function reportProgress(
  onUpdate: AgentToolUpdateCallback<{ tool: string }> | undefined,
  tool: string,
  message: string,
): void {
  onUpdate?.({ content: [{ type: 'text', text: message }], details: { tool } });
}

function appendGuidance(
  result: AgentToolResult<{ tool: string }>,
  guidance: string,
): AgentToolResult<{ tool: string }> {
  return { ...result, content: [...result.content, { type: 'text', text: guidance }] };
}

function statusAction(runKey: string): string {
  return `workflow_run {"action":"status","runKey":${JSON.stringify(runKey)}}`;
}

function actionGuidance(action: WorkflowRunInput['action'], runKey: string): string[] {
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

const launchFailureOptions = [
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
      const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId());
      dependencies.observeSession?.(sessionId);
      const agiflowJobKind = input.env?.[AGIFLOW_JOB_KIND_ENV]?.trim();
      const agiflowJobId = input.env?.[AGIFLOW_JOB_ID_ENV]?.trim();
      if (Boolean(agiflowJobKind) !== Boolean(agiflowJobId)) {
        throw new Error('Agiflow workflow launches require AGIFLOW_JOB_KIND and AGIFLOW_JOB_ID together.');
      }
      if (agiflowJobKind && !input.prompt?.trim()) {
        throw new Error(
          'Agiflow workflow launches require a non-empty prompt so user_prompt runs do not wait for terminal input.',
        );
      }
      reportProgress(onUpdate, LAUNCH_WORKFLOW_TOOL_NAME, 'Checking workflow capacity...');
      const maxConcurrent = resolveMaxConcurrent();
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
      if (process.env.AGIFLOW_DISPATCH_CONTEXT_FILE) {
        for (const key of [
          'AGIFLOW_ORGANIZATION_ID',
          'AGIFLOW_PROJECT_ID',
          'AGIFLOW_DEVICE_ID',
          'BACKEND_AGIFLOW_API_ENDPOINT',
          'AGIFLOW_DISPATCH_SECRET_FILE',
        ] as const) {
          const hostValue = process.env[key];
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

export function registerWorkflowPiTools(pi: ExtensionAPI, dependencies: WorkflowPiToolDependencies = {}): void {
  const feature = dependencies.feature ?? createEmbeddedWorkflowFeature();
  const runTool = dependencies.runTool ?? feature.runTool;
  const listWorkflowsTool = dependencies.listWorkflowsTool ?? feature.listWorkflowsTool;
  const recoverTool = dependencies.recoverTool ?? feature.createRecoverTool();
  const controlTool = dependencies.controlTool ?? feature.createControlTool();
  const trackPendingRun = dependencies.trackPendingRun ?? (<T>(run: Promise<T>): Promise<T> => run);
  const launchExecutor =
    dependencies.launchExecutor ??
    createWorkflowLaunchExecutor({
      activeRunCount: dependencies.activeRunCount,
      onLaunch: dependencies.onLaunch,
      observeSession: dependencies.observeSession,
      rejectRunner: dependencies.rejectRunner,
      runTool,
      trackPendingRun,
    });

  pi.registerTool({
    name: LIST_WORKFLOWS_TOOL_NAME,
    label: 'List Workflows',
    description: 'List the workflow definitions available in this repository.',
    promptSnippet: 'List available workflow definitions',
    parameters: z.toJSONSchema(listWorkflowsTool.getInputSchema()),
    renderShell: 'self',
    renderCall: (args, theme) =>
      renderWorkflowToolCall(LIST_WORKFLOWS_TOOL_NAME, args as Record<string, unknown>, theme),
    renderResult: (result, options, theme, context) =>
      renderWorkflowToolResult(
        LIST_WORKFLOWS_TOOL_NAME,
        context.args as Record<string, unknown>,
        result,
        { ...options, isError: context.isError },
        theme,
      ),
    async execute(_toolCallId, params) {
      return toAgentToolResult(
        LIST_WORKFLOWS_TOOL_NAME,
        await listWorkflowsTool.execute(
          params as Parameters<EmbeddedWorkflowFeature['listWorkflowsTool']['execute']>[0],
        ),
      );
    },
  });

  pi.registerTool({
    name: LAUNCH_WORKFLOW_TOOL_NAME,
    label: 'Launch Workflow',
    description:
      'Start a workflow run. Returns once the run has started, not once it finishes; use workflow_run with action status or wait for the completion notice.',
    promptSnippet: 'Start a workflow run and return its identifier',
    promptGuidelines: [
      'Before launching, call list_workflows and pick the workflow whose own description matches the work. A workflow description is the source of truth; never infer one from its filename. If nothing matches, say so and stop rather than launching an approximate fit.',
      'launch_workflow returns when the run has STARTED, not when it has finished. Never report success from its result. Poll workflow_run with action status, or wait for the completion notice the extension delivers on its own.',
      'When dispatching Agiflow work, pass AGIFLOW_JOB_KIND and AGIFLOW_JOB_ID together through env plus a non-empty prompt. The id alone is not a key, and omitting prompt leaves user_prompt workflows waiting for terminal input.',
      'A workflow claims its own job in its pre step. Never claim a job yourself. JOB_ALREADY_CLAIMED or HTTP 409 means another worker won the race, so report contention and do not unlock, release, or retry automatically.',
      'If a result says WORKFLOW_NOT_OWNED or a release failed, inspect current ownership and ask the user before any release or unlock. Never force another worker’s lock.',
      'If a running workflow is not found, call workflow_run with action status to re-check current state before retrying.',
      'The per-session concurrency ceiling is a real limit. If launch_workflow refuses, wait for a run to finish; do not launch through the shell to get around it.',
    ],
    parameters: z.toJSONSchema(runTool.getInputSchema().pick(PI_LAUNCH_FIELDS)),
    renderShell: 'self',
    renderCall: (args, theme) =>
      renderWorkflowToolCall(LAUNCH_WORKFLOW_TOOL_NAME, args as Record<string, unknown>, theme),
    renderResult: (result, options, theme, context) =>
      renderWorkflowToolResult(
        LAUNCH_WORKFLOW_TOOL_NAME,
        context.args as Record<string, unknown>,
        result,
        { ...options, isError: context.isError },
        theme,
      ),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const input = params as WorkflowLaunchInput;
      const result = await launchExecutor.execute(input, ctx, onUpdate);
      const adapted = toAgentToolResult(LAUNCH_WORKFLOW_TOOL_NAME, result, launchFailureOptions);
      return appendGuidance(
        adapted,
        'Next: call workflow_run with action status and verify the recorded stage before reporting the workflow outcome.',
      );
    },
  });

  pi.registerTool({
    name: WORKFLOW_RUN_TOOL_NAME,
    label: 'Workflow Run',
    description:
      'Inspect or control one workflow run. Use action status, tail, recovery-evidence, follow, open, pause, resume, stop, or recover. Every action requires an exact run key.',
    promptSnippet: 'Inspect or control a workflow run',
    promptGuidelines: [
      'Use action status as the authority for stage, outcome, execution state, and pause cursor. A run that started is not a run that succeeded.',
      'Use action pause or resume for cooperative lifecycle control. Pause is not stop: the run keeps its stage running, capacity, services, and heartbeat while paused.',
      'Use action stop only when the user requests stopping a run. A user-requested stop is not a failure and needs no failure diagnosis.',
      'Do not use follow or tail merely to wait for a healthy run; use status or the completion notice. Tail returns chat-safe status without raw PTY frames. Use follow only when the user asks to pin live progress, and open only when a human wants the recorded launcher foregrounded.',
      'Use action recovery-evidence for terminal-only, durable status and artifacts before recovery. It is the only inspection path that may read a failed run from an earlier session and it never reads a live launcher.',
      'Use action recover only after loading the `workflow-recovery` skill and gathering its required evidence. Recovery may adopt a terminal failed run from an earlier Pi session; it never grants cross-session control of running work. Never edit issue.md or repair.json, and verify real process and registry progress before recovery.',
      'Never unlock or force-release an Agiflow claim from this tool.',
    ],
    parameters: z.toJSONSchema(workflowRunInputSchema),
    renderShell: 'self',
    renderCall: (args, theme) => renderWorkflowToolCall(WORKFLOW_RUN_TOOL_NAME, args as Record<string, unknown>, theme),
    renderResult: (result, options, theme, context) =>
      renderWorkflowToolResult(
        WORKFLOW_RUN_TOOL_NAME,
        context.args as Record<string, unknown>,
        result,
        { ...options, isError: context.isError },
        theme,
      ),
    async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
      const input = workflowRunInputSchema.parse(rawParams);
      const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId());
      dependencies.observeSession?.(sessionId);
      const selector: WorkflowRunSelector = { runKey: input.runKey, workspace: input.workspace };
      const requireOwnedRun = async (): Promise<WorkflowRunRecord> => {
        if (!dependencies.requireSessionRun) {
          throw new Error('Workflow run ownership is not available in this session.');
        }
        return dependencies.requireSessionRun(selector, sessionId);
      };

      if (input.action === 'status') {
        const record = await requireOwnedRun();
        return {
          content: [{ type: 'text', text: JSON.stringify(record, null, 2) }],
          details: { tool: WORKFLOW_RUN_TOOL_NAME },
        };
      }
      if (input.action === 'tail') {
        if (!dependencies.tailRun) throw new Error('Reading workflow output is not available in this session.');
        const record = await requireOwnedRun();
        reportProgress(onUpdate, WORKFLOW_RUN_TOOL_NAME, `Reading output for workflow ${input.runKey}...`);
        await dependencies.tailRun(selector, ctx);
        return {
          content: [
            {
              type: 'text',
              text: [
                `Workflow: ${record.displayName} (${record.runKey})`,
                `Stage: ${record.effectiveStage ?? record.stage}`,
                'Raw launcher output is hidden from chat. Use action follow or open to view it.',
              ].join('\n'),
            },
          ],
          details: { tool: WORKFLOW_RUN_TOOL_NAME },
        };
      }
      if (input.action === 'recovery-evidence') {
        if (!dependencies.readRecoveryEvidence) {
          throw new Error('Reading workflow recovery evidence is not available in this session.');
        }
        reportProgress(onUpdate, WORKFLOW_RUN_TOOL_NAME, `Reading recovery evidence for workflow ${input.runKey}...`);
        return {
          content: [{ type: 'text', text: await dependencies.readRecoveryEvidence(selector, ctx) }],
          details: { tool: WORKFLOW_RUN_TOOL_NAME },
        };
      }
      if (input.action === 'follow') {
        if (!dependencies.followRun) throw new Error('Following workflow output is not available in this session.');
        await requireOwnedRun();
        reportProgress(onUpdate, WORKFLOW_RUN_TOOL_NAME, `Following workflow ${input.runKey}...`);
        return {
          content: [{ type: 'text', text: await dependencies.followRun(selector, ctx) }],
          details: { tool: WORKFLOW_RUN_TOOL_NAME },
        };
      }
      if (input.action === 'open') {
        if (!dependencies.openRun) throw new Error('Opening a workflow launcher is not available in this session.');
        await requireOwnedRun();
        reportProgress(onUpdate, WORKFLOW_RUN_TOOL_NAME, `Opening workflow ${input.runKey}...`);
        return {
          content: [{ type: 'text', text: await dependencies.openRun(selector, ctx) }],
          details: { tool: WORKFLOW_RUN_TOOL_NAME },
        };
      }

      if (input.action === 'recover') {
        if (!dependencies.requireRecoverableRun) {
          throw new Error('Workflow recovery ownership transfer is not available in this session.');
        }
        const recoverable = await dependencies.requireRecoverableRun(selector);
        const recoverySelector = { runKey: recoverable.runKey, workspace: recoverable.workspace };
        reportProgress(onUpdate, WORKFLOW_RUN_TOOL_NAME, `Recovering workflow ${input.runKey}...`);
        // A recovery replays the workflow, and the replay skips the launch
        // step, so every job runs in THIS process. For a workflow whose steps
        // are interactive that means an agent TUI spawned onto this process's
        // own terminal. Hand it to a launcher instead, where the workflow says
        // how. A dry run prints rather than executes, so it stays here.
        if (!input.dryRun) {
          const delegated = await dependencies.delegateRecovery?.({ ...recoverySelector, runner: input.runner }, ctx);
          if (delegated) {
            const guidance = actionGuidance(input.action, input.runKey);
            await dependencies.onLaunch?.(ctx);
            return {
              content: [{ type: 'text', text: [delegated, guidance[0]].join('\n\n') }],
              details: { tool: WORKFLOW_RUN_TOOL_NAME },
            };
          }
        }
        const recoverInput = {
          dryRun: input.dryRun,
          job: input.job,
          runKey: recoverySelector.runKey,
          runner: input.runner,
          workspace: recoverySelector.workspace,
        };
        const result = await trackPendingRun(recoverTool.execute(recoverInput));
        const guidance = actionGuidance(input.action, input.runKey);
        const adapted = toAgentToolResult(WORKFLOW_RUN_TOOL_NAME, result, guidance);
        await dependencies.onLaunch?.(ctx);
        return appendGuidance(adapted, guidance[0]!);
      }

      const ownedRun = await requireOwnedRun();
      if (!ownedRun.runId) throw new Error(`Workflow ${input.runKey} has no controllable run generation.`);
      reportProgress(onUpdate, WORKFLOW_RUN_TOOL_NAME, `Requesting ${input.action} for workflow ${input.runKey}...`);
      const result = await controlTool.execute({
        action: input.action,
        expectedRunId: ownedRun.runId,
        reason: input.reason,
        runKey: input.runKey,
        workspace: input.workspace,
      });
      const guidance = actionGuidance(input.action, input.runKey);
      const adapted = toAgentToolResult(WORKFLOW_RUN_TOOL_NAME, result, guidance);
      return appendGuidance(adapted, guidance[0]!);
    },
  });
}
