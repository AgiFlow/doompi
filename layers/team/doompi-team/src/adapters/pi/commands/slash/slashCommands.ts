/**
 * The core `/run`, `/chain`, `/parallel` slash commands. Replaces the
 * always-blocking predecessor with the async-only shape this port settled
 * on: a command launches a spawn, sends an initial status message, and
 * hands off to `watchTrackedRunUntilTerminal` (render-key gated, backed by
 * `PollScheduler`) to update the status bar and finalize the message once
 * the run reaches a terminal state - never by awaiting completion. See
 * `subagentLaunch.ts`'s module doc for the full reasoning.
 *
 * WHAT IS NOT HERE, AND WHY:
 * - `/run-chain`, `/prompt-workflow` and `/chain-prompts`: the whole SAVED
 *   work surface - saved agent pipelines (`ChainConfig`, never ported) and
 *   saved `.md` prompt templates (ported, then deleted). REMOVED BY
 *   DECISION, not deferred: overly complicated for the use they were
 *   getting. Do not re-add them because a reader notices the predecessor had
 *   them. Ad-hoc chaining (`/chain scout "x" -> planner`) is a different
 *   feature, lives in `chainExpression.ts`, and stays
 * - `/subagent-cost`: REMOVED BY DECISION. It reads usage/cost data
 *   (`totalTokens`/`totalCost`) that nothing in this package's
 *   runs/extensions surface tracks - a genuinely absent data source, and
 *   building it would mean threading usage out of every child process
 * - `/subagents-check-profile`: removed at the source. Calls
 *   `checkSubagentProfile`/`listSubagentProfiles`, which are referenced but
 *   defined nowhere in the entire predecessor package - a live
 *   `ReferenceError` that only shipped because that package sets
 *   `noCheck: true`. Typecheck is on here; porting it faithfully would not
 *   compile, and it was asked to be removed independently of that
 * - The `SUBAGENT_FLEET_COMMAND` registration and its `Ctrl+Alt+F` shortcut:
 *   fleet view is its own piece, registered by whoever builds it
 * - Inline parallel groups within `/chain` (`(a | b)` syntax): the field
 *   mapping for a group's own config exists (`spawnRequestMapping.ts`),
 *   but wiring a group INTO a chain request is left for the same pass that
 *   revisits per-task field support, so `/chain` reports a clear
 *   not-yet-supported message rather than silently flattening a group
 * - `/subagents` (admin) command registration: a separate file, not yet
 *   ported
 *
 * `/subagents-doctor` IS here, in `doctor.ts` - read (not ported) the
 * predecessor's foreground-executor `doctor` action before deciding, and it
 * turned out to be a small, mostly-mechanical port. See that module's own
 * doc for what it deliberately leaves out (chain counts, spawn-budget
 * reporting).
 *
 * AVOID:
 * - Awaiting a SINGLE/PARALLEL spawn for a result that will not exist yet.
 *   See `subagentLaunch.ts`
 * - A private polling loop for a message's live status. Use
 *   `watchTrackedRunUntilTerminal`
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ExtensionConfig } from '../../extensions/config';
import type { ManagementActionsContract } from '../../extensions/managementActions';
import { captureSessionForkSource, type SpawnPlannerContract, type SpawnPlanResult } from '../../extensions/spawnPlan';
import type { SkillDiscoveryContract } from '../../../agents/skills';
import type { AgentScope, AgentDiscoveryContract } from '../../../agents/types';
import type { AsyncJobTrackerContract, TrackedAsyncJobsContract, TrackedAsyncJob } from '../../../asyncJobTracker';
import { resolveTrackedRunId, TERMINAL_ASYNC_JOB_STATES } from '../../../asyncJobTracker';
import { normalizeParentModel } from '../../../runs/shared/modelFallback';
import { authenticatedModelInfos } from '../../../../services/models/modelResolution';
import type { PollSchedulerContract } from '../../../pollScheduler';
import {
  extractForkFlag,
  type InlineConfig,
  type ParsedStep,
  parseAgentToken,
  parseSingleTaskToken,
  SlashParseError,
} from './chainExpression';
import { buildDoctorReport } from './doctor';
import { taskInputFromParsedStep, UnsupportedInlineConfigError } from './spawnRequestMapping';
import { launchParallelSubagents, launchSingleSubagent, watchTrackedRunUntilTerminal } from './subagentLaunch';

export interface SlashCommandDeps {
  spawnPlanner: SpawnPlannerContract;
  skills: SkillDiscoveryContract;
  tracker: AsyncJobTrackerContract;
  scheduler: PollSchedulerContract;
  discovery: AgentDiscoveryContract;
  /**
   * Used by `/subagents-stop`. Preferred over calling `requestSlashRunStop`
   * directly because it resolves an id PREFIX through `RunIdResolver` and
   * raises a real error for an unknown or ambiguous one, instead of writing a
   * stop request into a directory for a run that does not exist.
   */
  management: ManagementActionsContract;
  loadConfig: () => ExtensionConfig;
}

export interface SlashCommandState {
  baseCwd: string | undefined;
}

const SLASH_STATUS_KEY = 'subagent-slash';
const STARTED_STATUS = 'started';

/**
 * The custom-message type a slash launch renders under. Cross-process
 * significant the same way `SUBAGENT_NOTIFY_MESSAGE_TYPE` is: the child-side
 * prompt runtime strips this type out of a child's inherited history
 * (`PARENT_ONLY_CUSTOM_MESSAGE_TYPES`), so both sides must agree on the literal.
 */
export const SLASH_RESULT_CUSTOM_TYPE = 'subagent-slash-result';

/**
 * One run's line in a slash-result message. `status` is the tracker's own
 * status string (plus `started`), not a closed set this module can narrow.
 */
export interface SlashRunDetail {
  agent: string;
  runId: string;
  status: string;
  error?: string;
  warning?: string;
}

function sendSlashText(pi: ExtensionAPI, text: string, details?: SlashRunDetail[]): void {
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

function notifyError(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, 'error');
}

function notifyInfo(ctx: ExtensionContext, message: string): void {
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

function reportSpawnResult(
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

function requireBaseCwd(state: SlashCommandState, ctx: ExtensionContext): string | undefined {
  if (state.baseCwd) return state.baseCwd;
  notifyError(ctx, 'Subagent session cwd is not initialized yet');
  return undefined;
}

function findAgentOrNotify(deps: SlashCommandDeps, baseCwd: string, name: string, ctx: ExtensionContext): boolean {
  const agents = deps.discovery.discover(baseCwd, 'both' satisfies AgentScope).agents;
  if (agents.find((agent) => agent.name === name)) return true;
  notifyError(ctx, `Unknown agent: ${name}`);
  return false;
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
  const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId());
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
        parentSessionId: ctx.sessionManager.getSessionId(),
        ...(taskInput.model ? { model: taskInput.model } : {}),
        ...(taskInput.context ? { context: taskInput.context } : {}),
        ...(parentForkSource
          ? { parentSessionFile: parentForkSource.sessionFile, parentLeafId: parentForkSource.leafId }
          : {}),
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

function reportKnownErrorOrRethrow(ctx: ExtensionContext, error: unknown): void {
  if (error instanceof UnsupportedInlineConfigError || error instanceof SlashParseError) {
    notifyError(ctx, error.message);
    return;
  }
  throw error;
}

/**
 * Shared arg parsing for /chain (no inline group) and /parallel:
 * "agent1 task1 -> agent2 task2" or "agent1 agent2 -- shared task".
 */
function parseAgentArgsFallback(input: string): { steps: ParsedStep[]; task: string; perStep: boolean } | undefined {
  const trimmed = input.trim();
  if (trimmed.includes(' -> ')) {
    const steps = trimmed
      .split(' -> ')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => parseSingleTaskToken(segment));
    if (steps.length === 0) return undefined;
    return { steps, task: steps.find((step) => step.task)?.task ?? '', perStep: true };
  }
  const delimiterIndex = trimmed.indexOf(' -- ');
  if (delimiterIndex === -1) return undefined;
  const agentsPart = trimmed.slice(0, delimiterIndex).trim();
  const sharedTask = trimmed.slice(delimiterIndex + 4).trim();
  if (!agentsPart || !sharedTask) return undefined;
  const steps = agentsPart
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => parseSingleTaskToken(token));
  if (steps.length === 0) return undefined;
  return { steps, task: sharedTask, perStep: false };
}

export function registerSlashCommands(pi: ExtensionAPI, state: SlashCommandState, deps: SlashCommandDeps): void {
  pi.registerCommand('run', {
    description: 'Run a subagent in the background: /run agent[model=x] [task] [--fork]',
    handler: async (args, ctx) => {
      const { args: cleanedArgs, fork } = extractForkFlag(args);
      const input = cleanedArgs.trim();
      if (!input) {
        notifyError(ctx, 'Usage: /run <agent> [task] [--fork]');
        return;
      }
      const firstSpace = input.indexOf(' ');
      const { name: agentName, config } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
      const task = firstSpace === -1 ? '' : input.slice(firstSpace + 1).trim();
      const outcome = await launchSingleAgentRun(pi, ctx, state, deps, { agent: agentName, task, config, fork });
      if (!outcome.ok) notifyError(ctx, outcome.message);
    },
  });

  pi.registerCommand('parallel', {
    description: 'Run agents in parallel: /parallel scout "task1" -> reviewer "task2" [--fork]',
    handler: async (args, ctx) => {
      const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId());
      const { args: cleanedArgs, fork } = extractForkFlag(args);
      const baseCwd = requireBaseCwd(state, ctx);
      if (!baseCwd) return;

      const parsed = parseAgentArgsFallback(cleanedArgs);
      if (!parsed) {
        notifyError(ctx, 'Usage: /parallel agent1 "task1" -> agent2 "task2"');
        return;
      }
      for (const step of parsed.steps) {
        if (!findAgentOrNotify(deps, baseCwd, step.name, ctx)) return;
      }
      if (!parsed.steps.some((step) => step.task) && !parsed.task) {
        notifyError(ctx, 'At least one step must have a task');
        return;
      }

      try {
        const parentForkSource = captureSessionForkSource(ctx.sessionManager, 'settled');
        const parentModel = normalizeParentModel(ctx.model);
        const tasks = parsed.steps.map((step) =>
          taskInputFromParsedStep(
            { name: step.name, config: step.config, task: step.task ?? parsed.task },
            baseCwd,
            fork ? 'fork' : undefined,
          ),
        );
        const result = await launchParallelSubagents(
          deps.spawnPlanner,
          jobs,
          {
            tasks,
            cwd: baseCwd,
            agentScope: 'both',
            parentSessionId: ctx.sessionManager.getSessionId(),
            ...(parentForkSource
              ? { parentSessionFile: parentForkSource.sessionFile, parentLeafId: parentForkSource.leafId }
              : {}),
            availableModels: authenticatedModelInfos(ctx.modelRegistry),
            ...(parentModel ? { parentModel } : {}),
          },
          deps.loadConfig(),
        );
        reportSpawnResult(pi, ctx, deps, jobs, result);
      } catch (error) {
        reportKnownErrorOrRethrow(ctx, error);
      }
    },
  });

  pi.registerCommand('subagents-doctor', {
    description: 'Show subagent diagnostics',
    handler: async (_args, ctx) => {
      sendSlashText(
        pi,
        buildDoctorReport({ cwd: ctx.cwd, agentScope: 'both' }, { discovery: deps.discovery, skills: deps.skills }),
      );
    },
  });

  pi.registerCommand('subagents-steer', {
    description: 'Send guidance to a running subagent: /subagents-steer <run-id> <message>',
    handler: async (args, ctx) => {
      const input = args.trim();
      const separator = input.search(/\s/);
      if (separator === -1 || !input.slice(separator + 1).trim()) {
        notifyError(ctx, 'Usage: /subagents-steer <run-id> <message>');
        return;
      }
      const id = input.slice(0, separator);
      const message = input.slice(separator + 1).trim();
      try {
        const result = await deps.management.steer(id, message);
        const summary = `Steering ${result.state} for ${id}: ${result.message}`;
        if (result.state === 'failed') notifyError(ctx, summary);
        else notifyInfo(ctx, summary);
      } catch (error) {
        notifyError(ctx, error instanceof Error ? error.message : `Could not steer '${id}'.`);
      }
    },
  });

  pi.registerCommand('subagents-stop', {
    description: 'Stop a running subagent: /subagents-stop [run-id]',
    handler: async (args, ctx) => {
      const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId());
      const id = args.trim();
      if (!id) {
        sendSlashText(pi, stoppableRunsReport(jobs.list()));
        return;
      }
      try {
        deps.management.stop(resolveTrackedRunId(jobs, id));
        // Deliberately reports the REQUEST, not the outcome. Stop is
        // asynchronous in this package: the request is a file the child
        // claims on its next control-channel tick, so claiming "stopped"
        // here would assert something this process has not observed. The
        // run's own status is what confirms it, via /subagents-fleet or a
        // completion notification.
        notifyInfo(ctx, `Stop requested for ${id}. The run reports its own final state once it acknowledges.`);
      } catch (error) {
        // `ManagementActions.stop` throws only for an id that resolves to no
        // run or to more than one. Both are bad user input, not internal
        // faults, so they are notified rather than rethrown at the host - the
        // same treatment `reportKnownErrorOrRethrow` gives a parse error.
        notifyError(ctx, error instanceof Error ? error.message : `Could not stop '${id}'.`);
      }
    },
  });
}

/**
 * The no-argument `/subagents-stop` listing.
 *
 * The predecessor opened a TUI selector overlay here. This reports the same
 * information as text instead, for one reason worth stating rather than
 * hiding: a selector is a second, independent renderer of run state, and this
 * package already has one in `/subagents-fleet` that shows more (live status,
 * transcripts, and the full set of runtime controls including stop). Building
 * a second, weaker one would mean two things to keep in step. Passing an
 * explicit id stays the direct path, and the fleet overlay is the interactive
 * one.
 */
function stoppableRunsReport(runs: readonly TrackedAsyncJob[]): string {
  const stoppable = runs.filter((run) => run.status === 'running' || run.status === 'pending');
  if (stoppable.length === 0) return 'No running subagents to stop.';
  const lines = stoppable.map((run) => `- ${run.runId}${run.status ? ` (${run.status})` : ''}`);
  return [
    'Running subagents:',
    ...lines,
    '',
    'Stop one with `/subagents-stop <run-id>`, or open `/subagents-fleet` to inspect and control them interactively.',
  ].join('\n');
}
