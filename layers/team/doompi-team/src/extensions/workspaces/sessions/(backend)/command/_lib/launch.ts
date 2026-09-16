/** Shared CLI launch and status helpers used by /run, /parallel, and the agent catalog. */

import { resolveRootSessionId } from '@agimon-ai/doompi-core/child-process';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { SkillDiscoveryContract } from '../../../../../../services/agentSkills';
import type {
  AsyncJobTrackerContract,
  TrackedAsyncJobsContract,
  TrackedAsyncJob,
} from '../../../../../../services/asyncJobTracker';
import { TERMINAL_ASYNC_JOB_STATES } from '../../../../../../services/asyncJobTracker';
import { type InlineConfig, SlashParseError } from '../../../../../../services/chainExpression';
import type { ExtensionConfig } from '../../../../../../services/config';
import type { ManagementActionsContract } from '../../../../../../services/managementActions';
import { normalizeParentModel } from '../../../../../../services/modelFallback';
import { authenticatedModelInfos } from '../../../../../../services/modelResolution';
import type { PollSchedulerContract } from '../../../../../../services/pollScheduler';
import { createSessionScope } from '../../../../../../services/sessionPaths';
import {
  captureSessionForkSource,
  forkRequestFields,
  type SpawnPlannerContract,
  type SpawnPlanResult,
} from '../../../../../../services/spawnPlan';
import { taskInputFromParsedStep, UnsupportedInlineConfigError } from '../../../../../../services/spawnRequestMapping';
import { launchSingleSubagent, watchTrackedRunUntilTerminal } from '../../../../../../services/subagentLaunch';
import type { AgentScope, AgentDiscoveryContract } from '../../../../../../types/agent';

export interface SlashCommandDeps {
  spawnPlanner: SpawnPlannerContract;
  skills: SkillDiscoveryContract;
  tracker: AsyncJobTrackerContract;
  scheduler: PollSchedulerContract;
  discovery: AgentDiscoveryContract;
  /** Session-scoped typed management for status, prefix resolution, and control. */
  management: ManagementActionsContract;
  loadConfig: () => ExtensionConfig;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface SlashCommandState {
  baseCwd: string | undefined;
}

export function sessionScopeFor(ctx: ExtensionContext, environment: Readonly<Record<string, string | undefined>>) {
  return createSessionScope(resolveRootSessionId(ctx.sessionManager.getSessionId(), environment));
}

const SLASH_STATUS_KEY = 'subagent-slash';
const STARTED_STATUS = 'started';

/**
 * The custom-message type a slash launch renders under. Cross-process
 * significant the same way `SUBAGENT_NOTIFY_MESSAGE_TYPE` is: the child-side
 * prompt runtime strips this type out of a child's inherited history
 * (`PARENT_ONLY_CUSTOM_MESSAGE_TYPES`), so both sides must agree on the literal.
 */
import { SLASH_RESULT_CUSTOM_TYPE, type SlashRunDetail } from '../../../../../../models/slashResult';
export function sendSlashText(pi: ExtensionAPI, text: string, details?: SlashRunDetail[]): void {
  pi.sendMessage({
    customType: SLASH_RESULT_CUSTOM_TYPE,
    content: text,
    display: true,
    ...(details ? { details } : {}),
  });
}

function setSlashStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(SLASH_STATUS_KEY, text);
}

export function notifyError(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, 'error');
}

export function notifyInfo(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, 'info');
}

function statusTextFor(job: TrackedAsyncJob | undefined): string {
  if (!job) return 'starting…';
  if (job.attentionReason) return `${job.status ?? 'running'} - needs attention: ${job.attentionReason}`;
  if (job.activityState) return `${job.status ?? 'running'} - ${job.activityState}`;
  return job.status ?? 'running';
}

/**
 * Watches one launched run to a terminal state and finalizes its message.
 * Each launched run gets its own subscriber, so a PARALLEL launch's
 * siblings finalize independently rather than all waiting on the slowest.
 */
function watchAndFinalize(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SlashCommandDeps,
  jobs: TrackedAsyncJobsContract,
  runId: string,
  agent: string,
): void {
  watchTrackedRunUntilTerminal(deps.scheduler, jobs, runId, (job) => {
    setSlashStatus(ctx, `${agent} (${runId}): ${statusTextFor(job)}`);
    if (job?.status === undefined || !TERMINAL_ASYNC_JOB_STATES.has(job.status)) return;
    setSlashStatus(ctx, undefined);
    const outcome = job.status === 'complete' || job.status === 'completed' ? 'completed' : job.status;
    sendSlashText(
      pi,
      job.error
        ? `## Subagent ${outcome}\n\n${agent} (${runId})\n\n${job.error}`
        : `## Subagent ${outcome}\n\n${agent} (${runId})`,
      [{ agent, runId, status: outcome, ...(job.error ? { error: job.error } : {}) }],
    );
  });
}

export function reportSpawnResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SlashCommandDeps,
  jobs: TrackedAsyncJobsContract,
  result: SpawnPlanResult,
): void {
  const started = result.outcomes.filter((outcome) => outcome.runId);
  const failed = result.outcomes.filter((outcome) => !outcome.runId);
  if (started.length > 0) {
    const label = started
      .map(
        (outcome) => `${outcome.agent} (${outcome.runId})${outcome.warning ? `\n  Warning: ${outcome.warning}` : ''}`,
      )
      .join(', ');
    sendSlashText(
      pi,
      `## Subagent started\n\n${label}`,
      started.map((outcome) => ({
        agent: outcome.agent,
        runId: outcome.runId ?? '',
        status: STARTED_STATUS,
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      })),
    );
    setSlashStatus(ctx, `${started.length} run${started.length === 1 ? '' : 's'} started…`);
    for (const outcome of started) {
      if (outcome.runId) watchAndFinalize(pi, ctx, deps, jobs, outcome.runId, outcome.agent);
    }
  }
  if (failed.length > 0) {
    const label = failed.map((outcome) => `${outcome.agent}: ${outcome.error ?? 'spawn failed'}`).join('\n');
    notifyError(ctx, `Some subagents failed to start:\n${label}`);
  }
}

export interface SingleAgentRunRequest {
  agent: string;
  task: string;
  /** Inline `agent[model=x]` config from a slash token; surfaces without that syntax send none. */
  config?: InlineConfig;
  fork?: boolean;
}

export type SingleAgentRunOutcome = { ok: true; result: SpawnPlanResult } | { ok: false; message: string };

/**
 * One agent, one task: the shared body of `/run` and the agent catalog's
 * launch key (`SPC a l`, `r`/`R`).
 *
 * Returns `ok: false` with a user-facing message for the validation failures
 * both surfaces share rather than notifying itself, because the two report
 * in different idioms - a slash command notifies, and a fullscreen overlay
 * writes a notice into its own body, where a notification would be covered.
 * Started runs are still reported here through `reportSpawnResult`, which is
 * what tracks them and finalizes their message; that is identical for both.
 */
export async function launchSingleAgentRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SlashCommandState,
  deps: SlashCommandDeps,
  request: SingleAgentRunRequest,
): Promise<SingleAgentRunOutcome> {
  const baseCwd = state.baseCwd;
  if (!baseCwd) return { ok: false, message: 'Subagent session cwd is not initialized yet' };
  const agents = deps.discovery.discover(baseCwd, 'both' satisfies AgentScope).agents;
  if (!agents.find((agent) => agent.name === request.agent)) {
    return { ok: false, message: `Unknown agent: ${request.agent}` };
  }
  const scope = sessionScopeFor(ctx, deps.environment);
  const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId(), scope);
  try {
    const parentForkSource = captureSessionForkSource(ctx.sessionManager, 'settled');
    const parentModel = normalizeParentModel(ctx.model);
    const taskInput = taskInputFromParsedStep(
      { name: request.agent, config: request.config ?? {}, task: request.task },
      baseCwd,
      request.fork ? 'fork' : undefined,
    );
    const result = await launchSingleSubagent(
      deps.spawnPlanner,
      jobs,
      {
        agent: taskInput.agent,
        task: taskInput.task ?? '',
        cwd: taskInput.cwd ?? baseCwd,
        agentScope: 'both',
        sessionScope: scope,
        parentSessionId: ctx.sessionManager.getSessionId(),
        ...(taskInput.model ? { model: taskInput.model } : {}),
        ...(taskInput.context ? { context: taskInput.context } : {}),
        ...forkRequestFields(parentForkSource),
        availableModels: authenticatedModelInfos(ctx.modelRegistry),
        ...(parentModel ? { parentModel } : {}),
      },
      deps.loadConfig(),
    );
    reportSpawnResult(pi, ctx, deps, jobs, result);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof UnsupportedInlineConfigError || error instanceof SlashParseError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

/**
 * `launchSingleAgentRun` for a surface that cannot await it - the agent
 * catalog closes on launch, so nothing is left to receive the outcome. The
 * failure paths report themselves here, once the overlay is gone and a
 * notification is visible again.
 */
export function startSingleAgentRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SlashCommandState,
  deps: SlashCommandDeps,
  request: SingleAgentRunRequest,
): void {
  void launchSingleAgentRun(pi, ctx, state, deps, request).then(
    (outcome) => {
      if (!outcome.ok) notifyError(ctx, outcome.message);
    },
    (error: unknown) => {
      notifyError(ctx, `Subagent launch failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}
