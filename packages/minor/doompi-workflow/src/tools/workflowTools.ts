import { resolveRootSessionId } from '@agimon-ai/doompi-core/child-process';
import {
  type WorkflowLaunchInput,
  type WorkflowRunSelector,
  launchFailureOptions,
} from '../services/workflowExecution';
import {
  createEmbeddedWorkflowFeature,
  type WorkflowRunRecord,
  type EmbeddedWorkflowFeature,
} from '@agimon-ai/workflow-mcp';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { workflowRunInputSchema } from '../schemas/workflowPi';
import { toAgentToolResult, type WorkflowToolDetails } from '../services/piToolBridge';
import {
  createWorkflowLaunchExecutor,
  reportProgress,
  appendGuidance,
  actionGuidance,
  type WorkflowPiToolDependencies,
} from '../services/workflowExecution';
type WorkflowToolSchema = Parameters<ExtensionAPI['registerTool']>[0]['parameters'];
import {
  WORKFLOW_PI_TOOL_NAMES,
  LIST_WORKFLOWS_TOOL_NAME,
  LAUNCH_WORKFLOW_TOOL_NAME,
  WORKFLOW_RUN_TOOL_NAME,
} from '../constants/workflow';
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
export type WorkflowNativeTool = ToolDefinition<WorkflowToolSchema, WorkflowToolDetails>;
export type WorkflowToolRenderers = Pick<WorkflowNativeTool, 'renderCall' | 'renderResult'>;
export function createWorkflowTools(
  dependencies: WorkflowPiToolDependencies,
  renderers: (name: (typeof WORKFLOW_PI_TOOL_NAMES)[number]) => WorkflowToolRenderers = () => ({}),
): WorkflowNativeTool[] {
  const feature = dependencies.feature ?? createEmbeddedWorkflowFeature();
  const runTool = dependencies.runTool ?? feature.runTool;
  const listWorkflowsTool = dependencies.listWorkflowsTool ?? feature.listWorkflowsTool;
  const recoverTool = dependencies.recoverTool ?? feature.createRecoverTool();
  const controlTool = dependencies.controlTool ?? feature.createControlTool();
  const trackPendingRun = dependencies.trackPendingRun ?? (<T>(run: Promise<T>): Promise<T> => run);
  const launchExecutor =
    dependencies.launchExecutor ??
    createWorkflowLaunchExecutor({
      environment: dependencies.environment,
      activeRunCount: dependencies.activeRunCount,
      onLaunch: dependencies.onLaunch,
      observeSession: dependencies.observeSession,
      rejectRunner: dependencies.rejectRunner,
      runTool,
      trackPendingRun,
    });

  return [
    {
      name: LIST_WORKFLOWS_TOOL_NAME,
      label: 'List Workflows',
      description: 'List the workflow definitions available in this repository.',
      promptSnippet: 'List available workflow definitions',
      parameters: z.toJSONSchema(listWorkflowsTool.getInputSchema()),
      renderShell: 'self',
      ...renderers(LIST_WORKFLOWS_TOOL_NAME),
      async execute(_toolCallId, params) {
        return toAgentToolResult(
          LIST_WORKFLOWS_TOOL_NAME,
          await listWorkflowsTool.execute(
            params as Parameters<EmbeddedWorkflowFeature['listWorkflowsTool']['execute']>[0],
          ),
        );
      },
    },

    {
      name: LAUNCH_WORKFLOW_TOOL_NAME,
      label: 'Launch Workflow',
      description:
        'Start a workflow run. Returns once the run has started, not once it finishes; use workflow_run with action status or wait for the completion notice.',
      promptSnippet: 'Start a workflow run and return its identifier',
      promptGuidelines: [
        'Before launching, call list_workflows and pick the workflow whose own description matches the work. A workflow description is the source of truth; never infer one from its filename. If nothing matches, say so and stop rather than launching an approximate fit.',
        'launch_workflow returns when the run has STARTED, not when it has finished. Never report success from its result. Poll workflow_run with action status, or wait for the completion notice the extension delivers on its own.',
        'When dispatching Agiflow work, pass AGIFLOW_PROJECT_ID, AGIFLOW_JOB_KIND, and AGIFLOW_JOB_ID through env plus a non-empty prompt. Kind must be task or work-unit. The id alone is not a key, and omitting prompt leaves user_prompt workflows waiting for terminal input.',
        'A workflow claims its own job in its pre step. Never claim a job yourself. JOB_ALREADY_CLAIMED or HTTP 409 means another worker won the race, so report contention and do not unlock, release, or retry automatically.',
        'If a result says WORKFLOW_NOT_OWNED or a release failed, inspect current ownership and ask the user before any release or unlock. Never force another worker’s lock.',
        'If a running workflow is not found, call workflow_run with action status to re-check current state before retrying.',
        'The per-session concurrency ceiling is a real limit. If launch_workflow refuses, wait for a run to finish; do not launch through the shell to get around it.',
      ],
      parameters: z.toJSONSchema(runTool.getInputSchema().pick(PI_LAUNCH_FIELDS)),
      renderShell: 'self',
      ...renderers(LAUNCH_WORKFLOW_TOOL_NAME),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const input = params as WorkflowLaunchInput;
        const result = await launchExecutor.execute(input, ctx, onUpdate);
        const adapted = toAgentToolResult(LAUNCH_WORKFLOW_TOOL_NAME, result, launchFailureOptions);
        return appendGuidance(
          adapted,
          'Next: call workflow_run with action status and verify the recorded stage before reporting the workflow outcome.',
        );
      },
    },

    {
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
      ...renderers(WORKFLOW_RUN_TOOL_NAME),
      async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
        const input = workflowRunInputSchema.parse(rawParams);
        const sessionId = resolveRootSessionId(ctx.sessionManager.getSessionId(), dependencies.environment);
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
    },
  ];
}
