import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { SUBAGENT_ACTIONS, SubagentToolSchema, type SubagentToolParams } from '../../../../../schemas/subagentTool';
import { resolveTrackedRunId } from '../../../../../services/asyncJobTracker';
import { loadConfig } from '../../../../../services/config';
import { DoomTeamExpectedError } from '../../../../../services/errors';
import { toModelInfo } from '../../../../../services/modelInfo';
import { createSessionScope } from '../../../../../services/sessionPaths';
import type { SpawnPlanResult } from '../../../../../services/spawnPlan';
import { formatFleetView } from '../../../../../services/statusViews';
import {
  formatAgentDetail,
  formatAgentList,
  publicAgent,
  validateParams as validateSubagentParams,
} from '../../../../../services/subagentTool';
import {
  clearSuspendedRun,
  formatSuspendedRuns,
  isSuspendedRunResumable,
  listSuspendedRuns,
} from '../../../../../services/suspendedRuns';
import { createTeamExtensionRuntime } from '../../../../../services/teamRuntime';
import type { TeamServerScope } from '../_lib/root.server';

const SUBAGENT_DESCRIPTION =
  'Discover agents, start and manage persistent background subagent runs, and inspect suspended work.';

/**
 * Every result carries the text the MODEL reads and the structured details the
 * cockpit card reads. The text is always given explicitly: a serialized detail
 * object is not a tool result a model can act on, and the old default made that
 * the easy mistake to make.
 */
function result(text: string, details: unknown, isError = false): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text }], details, ...(isError ? { isError: true } : {}) };
}

/** The launch report, worded as the Pi path words it, next step included. */
function formatSpawnPlan(plan: SpawnPlanResult): string {
  const started = plan.outcomes.filter((outcome) => outcome.runId);
  const failed = plan.outcomes.filter((outcome) => !outcome.runId);
  const lines = plan.outcomes.map(
    (outcome) =>
      `- ${outcome.agent}: ${outcome.runId ? outcome.runId : `failed: ${outcome.error ?? 'unknown error'}`}${outcome.warning ? `\n  Warning: ${outcome.warning}` : ''}`,
  );
  const label = plan.outcomes.length === 1 ? 'subagent' : 'subagents';
  const summary =
    failed.length === 0
      ? `Started ${started.length} ${label}:`
      : `Started ${started.length}/${plan.outcomes.length} ${label}; ${failed.length} failed:`;
  const next =
    failed.length === 0
      ? 'Completion will arrive asynchronously. Continue only non-overlapping work, or end your turn.'
      : 'Completion will arrive asynchronously for started runs. Do not resubmit them; retry only corrected failed entries.';
  return [summary, ...lines, '', next].join('\n');
}

function scopeOf(value: string | undefined): 'user' | 'project' | 'both' {
  return value === 'user' || value === 'project' ? value : 'both';
}

function subagentTool(
  runtime: ReturnType<typeof createTeamExtensionRuntime>,
  execution: DoomHeadlessExecutionContext,
): DoomHeadlessTool<typeof SubagentToolSchema> {
  const scope = createSessionScope(execution.sessionId);
  const jobs = runtime.asyncJobTracker.forSession(execution.sessionId, scope);
  const availableModels = execution.model ? [toModelInfo(execution.model)] : [];
  return {
    name: 'subagent',
    label: 'Subagent',
    description: SUBAGENT_DESCRIPTION,
    parameters: SubagentToolSchema,
    promptSnippet: 'Discover, run, inspect, steer, stop, and restore persistent subagents',
    promptGuidelines: [
      'Runs are persistent background work. Do not resubmit a run that already returned an id.',
      'Use status or suspended before retrying a failed or interrupted operation.',
    ],
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal, onUpdate) {
      try {
        const params: SubagentToolParams = validateSubagentParams(parameters);
        if (params.action === SUBAGENT_ACTIONS.agents) {
          const scope = scopeOf(params.scope);
          const agents = runtime.discovery.discover(params.cwd ?? execution.cwd, scope).agents;
          const selected = params.name
            ? runtime.discovery.find(params.cwd ?? execution.cwd, scope, params.name)
            : undefined;
          if (params.name && !selected)
            throw new DoomTeamExpectedError(
              'agent_not_found',
              `No executable agent matches '${params.name}'.`,
              false,
              'Call subagent({"action":"agents"}) and retry with an exact agent name.',
            );
          if (selected) return result(formatAgentDetail(selected), { agents: [publicAgent(selected)] });
          return result(formatAgentList(agents), {
            agents: agents.map((agent) => ({
              name: agent.name,
              source: agent.source,
              description: agent.description,
              runtime: agent.runtime ?? 'pi',
            })),
          });
        }
        if (params.action === SUBAGENT_ACTIONS.run) {
          onUpdate?.(
            result(`Starting ${params.requests.length} subagent${params.requests.length === 1 ? '' : 's'}...`, {
              action: params.action,
              partial: true,
            }),
          );
          // An agent whose resolved default context is `fork` needs a parent
          // branch here too, not only on the delegation path.
          const parentForkSource = await execution.session.forkSource?.();
          const plan = await runtime.spawnPlanner.spawn(
            {
              tasks: params.requests.map((request) => ({
                agent: request.agent.trim(),
                task: request.task.trim(),
                ...(request.inlineAgent ? { inlineAgent: request.inlineAgent } : {}),
                ...(request.cwd ? { cwd: request.cwd } : {}),
                ...(request.model ? { model: request.model } : {}),
                ...(request.runtime ? { runtime: request.runtime } : {}),
              })),
              cwd: execution.cwd,
              agentScope: scopeOf(params.scope),
              sessionScope: createSessionScope(execution.sessionId),
              environment: execution.environment,
              parentSessionId: execution.sessionId,
              ...(params.concurrency === undefined ? {} : { concurrency: params.concurrency }),
              ...(params.artifacts === undefined ? {} : { artifacts: params.artifacts }),
              availableModels,
              ...(execution.model ? { parentModel: execution.model } : {}),
              ...(parentForkSource ? { parentForkSource } : {}),
            },
            loadConfig().config,
          );
          for (const outcome of plan.outcomes) if (outcome.runId) jobs.track(outcome.runId);
          return result(formatSpawnPlan(plan), plan);
        }
        if (params.action === SUBAGENT_ACTIONS.status) {
          if (!('id' in params)) {
            const runs = jobs.list();
            return result(formatFleetView(runs), { runs });
          }
          const status = runtime.management.status(params.id);
          return result(
            status.status
              ? `Run '${status.runId}': ${status.status.state}`
              : `Run '${status.runId}' has no status yet.`,
            { runId: status.runId, status: status.status },
          );
        }
        if (params.action === SUBAGENT_ACTIONS.suspended) {
          const suspended = listSuspendedRuns(createSessionScope(execution.sessionId));
          const text = suspended.length ? formatSuspendedRuns(suspended) : 'No suspended subagents in this session.';
          return result(text, { suspended, text });
        }
        const id = resolveTrackedRunId(jobs, params.id);
        if (params.action === SUBAGENT_ACTIONS.stop) {
          const control = await runtime.management.stop(id, params.reason);
          return result(`Stop requested for '${id}'.`, { runId: id, control });
        }
        if (params.action === SUBAGENT_ACTIONS.steer) {
          const steer = await runtime.management.steer(id, params.message, undefined, signal);
          return result(`Steer request '${steer.requestId}' for '${id}' is ${steer.state}: ${steer.message}`, {
            runId: id,
            steer,
          });
        }
        const suspended = listSuspendedRuns(createSessionScope(execution.sessionId)).find(
          (item) => item.runId === params.id,
        );
        if (!suspended) throw new Error(`No suspended run matches '${params.id}'.`);
        if (!isSuspendedRunResumable(suspended)) throw new Error(`Suspended run '${params.id}' is not resumable.`);
        const restored = await runtime.spawnPlanner.spawn(
          {
            single: {
              agent: suspended.agent,
              ...(suspended.inlineAgent ? { inlineAgent: suspended.inlineAgent } : {}),
              task: suspended.task,
              cwd: suspended.cwd,
              ...(suspended.model ? { model: suspended.model } : {}),
              sessionFile: suspended.sessionFile,
            },
            cwd: suspended.cwd,
            agentScope: 'both',
            sessionScope: createSessionScope(execution.sessionId),
            environment: execution.environment,
            runtime: 'pi',
            parentSessionId: execution.sessionId,
            availableModels,
          },
          loadConfig().config,
        );
        const outcome = restored.outcomes[0];
        if (!outcome?.runId)
          throw new Error(`Could not restore '${params.id}': ${outcome?.error ?? 'the spawn produced no run.'}`);
        clearSuspendedRun(createSessionScope(execution.sessionId), params.id);
        return result(`Restored '${params.id}' as '${outcome.runId}', continuing its transcript.`, {
          restore: { ...outcome, restoredFrom: params.id },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(message, message, true);
      }
    },
  };
}

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TeamServerScope>) =>
  subagentTool(context.root.runtime, context.root.execution),
);
