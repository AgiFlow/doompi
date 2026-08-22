import { randomUUID } from 'node:crypto';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { agentHasWriteTools } from '../../agents/memory';
import type { AgentConfig, AgentScope, AgentDiscoveryContract } from '../../agents/types';
import { type AsyncJobTrackerContract, resolveTrackedRunId } from '../../asyncJobTracker';
import {
  clearSuspendedRun,
  formatSuspendedRuns,
  isSuspendedRunResumable,
  listSuspendedRuns,
  type SuspendedRun,
} from '../../suspendedRuns';
import { normalizeParentModel } from '../../runs/shared/modelFallback';
import { isPiRuntime } from '../../runs/shared/runtimeRegistry';
import { DoomTeamExpectedError, invalidRequest } from '../../../services/support/errors';
import { authenticatedModelInfos } from '../../../services/models/modelResolution';
import { requireCurrentSessionScope } from '../../filesystem/paths';
import { renderSubagentCall, renderSubagentResult } from '../tui/subagentToolRender';
import { loadConfig } from './config';
import type { ManagementActionsContract, StatusActionResult } from './managementActions';
import { completeOperation, startOperation } from './operationJournal';
import {
  SUBAGENT_ACTION_FIELDS,
  SUBAGENT_ACTIONS,
  type SubagentAction,
  SubagentParams,
  type SubagentToolParams,
} from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import {
  captureSessionForkSource,
  type SpawnPlannerContract,
  type SpawnPlanRequest,
  type SpawnPlanResult,
} from './spawnPlan';
import { DEFAULT_TRANSCRIPT_LINES, formatFleetView, formatRunTranscript } from './statusViews';
import { SUBAGENT_TOOL_DESCRIPTION } from './toolDescription';

export const SUBAGENT_TOOL_NAME = 'subagent';
export const IMPLEMENTED_SUBAGENT_ACTIONS: ReadonlySet<string> = new Set(Object.values(SUBAGENT_ACTIONS));

type SubagentToolDetails = Record<string, unknown>;

function textResult<T extends SubagentToolDetails>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details };
}

function progressResult(text: string, action: SubagentAction): AgentToolResult<SubagentToolDetails> {
  return textResult(text, { action, partial: true });
}

function progressMessage(params: SubagentToolParams): string | undefined {
  switch (params.action) {
    case SUBAGENT_ACTIONS.run:
      return `Starting ${params.requests.length} subagent${params.requests.length === 1 ? '' : 's'}...`;
    case SUBAGENT_ACTIONS.steer:
      return `Steering subagent ${params.id}...`;
    case SUBAGENT_ACTIONS.stop:
      return `Requesting stop for subagent ${params.id}...`;
    case SUBAGENT_ACTIONS.restore:
      return `Restoring subagent ${params.id}...`;
    default:
      return undefined;
  }
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
  try {
    return pi.getAllTools().some((tool) => tool.name === name);
  } catch {
    return false;
  }
}

function scopeOrDefault(scope: AgentScope | undefined): AgentScope {
  return scope ?? 'both';
}

function formatAgentList(agents: AgentConfig[]): string {
  return [
    'Executable agents:',
    ...(agents.length
      ? agents
          .toSorted((left, right) => left.name.localeCompare(right.name))
          .map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}`)
      : ['- (none)']),
  ].join('\n');
}

function publicAgent(agent: AgentConfig): Record<string, unknown> {
  const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)];
  return {
    name: agent.name,
    source: agent.source,
    description: agent.description,
    runtime: agent.runtime ?? 'pi',
    writeCapable: agentHasWriteTools(agent),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.fallbackModels?.length ? { fallbackModels: agent.fallbackModels } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

function publicSuspendedRun(run: SuspendedRun): SuspendedRun & { resumable: boolean } {
  return { ...run, resumable: isSuspendedRunResumable(run) };
}

function formatAgentDetail(agent: AgentConfig): string {
  const detail = publicAgent(agent);
  return [
    `Agent: ${agent.name} (${agent.source})`,
    `Description: ${agent.description}`,
    `Runtime: ${String(detail.runtime)}`,
    `Write capable: ${detail.writeCapable ? 'yes' : 'no'}`,
    ...(agent.model ? [`Model: ${agent.model}`] : []),
    ...(Array.isArray(detail.tools) ? [`Tools: ${detail.tools.join(', ')}`] : []),
  ].join('\n');
}

function requireNonblank(record: Record<string, unknown>, field: string, action: string): void {
  if (typeof record[field] !== 'string' || !record[field].trim()) {
    throw invalidRequest(`action='${action}' requires nonblank '${field}'.`, 'Correct the request and retry.');
  }
}

/** Remove the one legacy field emitted by Doom Plan before strict validation. */
function normalizeCompatibilityParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.action !== 'string' ||
    !IMPLEMENTED_SUBAGENT_ACTIONS.has(record.action) ||
    record.action === SUBAGENT_ACTIONS.run ||
    typeof record.model !== 'string'
  ) {
    return raw;
  }
  const { model: _model, ...normalized } = record;
  return normalized;
}

function validateParams(input: unknown): SubagentToolParams {
  const raw = normalizeCompatibilityParams(input);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidRequest('subagent parameters must be an object.', 'Call subagent with one documented action shape.');
  }
  const record = raw as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== 'string' || !IMPLEMENTED_SUBAGENT_ACTIONS.has(action)) {
    throw invalidRequest(
      `Unsupported or missing subagent action ${JSON.stringify(action)}.`,
      `Use one of: ${[...IMPLEMENTED_SUBAGENT_ACTIONS].join(', ')}.`,
    );
  }
  const allowed = SUBAGENT_ACTION_FIELDS[action as SubagentAction] as readonly string[];
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length) {
    throw invalidRequest(
      `action='${action}' does not accept: ${unknown.join(', ')}.`,
      'Remove unknown fields and retry.',
    );
  }
  if (action === SUBAGENT_ACTIONS.run && (!Array.isArray(record.requests) || record.requests.length === 0)) {
    throw invalidRequest("action='run' requires a nonempty 'requests' array.", 'Add at least one agent and task.');
  }
  if (action === SUBAGENT_ACTIONS.steer) {
    requireNonblank(record, 'id', action);
    requireNonblank(record, 'message', action);
  }
  if (action === SUBAGENT_ACTIONS.stop || action === SUBAGENT_ACTIONS.restore) requireNonblank(record, 'id', action);
  return raw as SubagentToolParams;
}

export interface SubagentToolContract {
  registerTool(pi: ExtensionAPI): void;
}

export class SubagentToolService implements SubagentToolContract {
  private readonly registeredHosts = new WeakSet<ExtensionAPI>();

  constructor(
    private readonly planner: SpawnPlannerContract,
    private readonly management: ManagementActionsContract,
    private readonly tracker: AsyncJobTrackerContract,
    private readonly discovery: AgentDiscoveryContract,
  ) {}

  registerTool(pi: ExtensionAPI): void {
    if (this.registeredHosts.has(pi)) return;
    if (hasTool(pi, SUBAGENT_TOOL_NAME)) {
      throw new DoomTeamExpectedError(
        'tool_conflict',
        `A foreign '${SUBAGENT_TOOL_NAME}' tool is already registered.`,
        false,
        'Disable the competing extension, then reload Doom Team.',
      );
    }
    pi.registerTool(this.buildTool());
    this.registeredHosts.add(pi);
  }

  private trackOutcomes(result: SpawnPlanResult, ctx: ExtensionContext): SpawnPlanResult {
    const jobs = this.tracker.forSession(ctx.sessionManager.getSessionId());
    for (const outcome of result.outcomes) {
      if (outcome.runId) jobs.track(outcome.runId);
    }
    return result;
  }

  private buildSpawnRequest(
    operationId: string,
    params: Extract<SubagentToolParams, { action: 'run' }>,
    ctx: ExtensionContext,
    preallocatedRunIds: string[],
  ): SpawnPlanRequest {
    const tasks = params.requests.map((request) => {
      if (!request.agent.trim() || !request.task.trim()) {
        throw invalidRequest(
          'Every run request requires nonblank agent and task values.',
          'Correct the request and retry.',
        );
      }
      return {
        agent: request.agent.trim(),
        ...(request.inlineAgent ? { inlineAgent: request.inlineAgent } : {}),
        task: request.task.trim(),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.runtime ? { runtime: request.runtime } : {}),
      };
    });
    const parentForkSource = captureSessionForkSource(ctx.sessionManager, 'tool');
    const parentModel = normalizeParentModel(ctx.model);
    return {
      tasks,
      cwd: ctx.cwd,
      agentScope: scopeOrDefault(params.scope),
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentForkSource
        ? { parentSessionFile: parentForkSource.sessionFile, parentLeafId: parentForkSource.leafId }
        : {}),
      ...(params.concurrency !== undefined ? { concurrency: params.concurrency } : {}),
      ...(params.artifacts !== undefined ? { artifacts: params.artifacts } : {}),
      availableModels: authenticatedModelInfos(ctx.modelRegistry),
      ...(parentModel ? { parentModel } : {}),
      operationId,
      preallocatedRunIds,
    };
  }

  private async executeRun(
    operationId: string,
    params: Extract<SubagentToolParams, { action: 'run' }>,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentToolDetails>> {
    const operation = startOperation<AgentToolResult<SubagentToolDetails>>(
      operationId,
      params,
      params.requests.map(() => randomUUID()),
    );
    if (operation.kind === 'replay') {
      if (operation.record.state === 'completed' && operation.record.result) return operation.record.result;
      throw new DoomTeamExpectedError(
        'delivery_unconfirmed',
        `Operation '${operationId}' is already pending for runs: ${operation.record.runIds.join(', ')}.`,
        true,
        'Call subagent({"action":"status"}) and do not submit the run again.',
      );
    }
    const result = this.trackOutcomes(
      await this.planner.spawn(
        this.buildSpawnRequest(operationId, params, ctx, operation.record.runIds),
        loadConfig().config,
      ),
      ctx,
    );
    const started = result.outcomes.filter((outcome) => outcome.runId);
    const failed = result.outcomes.filter((outcome) => !outcome.runId);
    const outcomeLines = result.outcomes.map(
      (outcome) =>
        `- ${outcome.agent}: ${outcome.runId ? outcome.runId : `failed: ${outcome.error ?? 'unknown error'}`}${outcome.warning ? `\n  Warning: ${outcome.warning}` : ''}`,
    );
    if (started.length === 0 && failed.length > 0) {
      throw new DoomTeamExpectedError(
        'runtime_unavailable',
        `No requested subagent started.\n${outcomeLines.join('\n')}`,
        true,
        'Correct the reported launch failures. If an agent name is uncertain, call subagent({"action":"agents"}) before retrying only corrected requests.',
      );
    }
    const subagentLabel = result.outcomes.length === 1 ? 'subagent' : 'subagents';
    const summary =
      failed.length === 0
        ? `Started ${started.length} ${subagentLabel}:`
        : `Started ${started.length}/${result.outcomes.length} ${subagentLabel}; ${failed.length} failed:`;
    const next =
      failed.length === 0
        ? 'Completion will arrive asynchronously. Continue only non-overlapping work, or end your turn.'
        : 'Completion will arrive asynchronously for started runs. Do not resubmit them; retry only corrected failed entries.';
    const response = textResult([summary, ...outcomeLines, '', next].join('\n'), {
      spawn: result,
      started: started.length,
      failed: failed.length,
    });
    completeOperation(operationId, operation.record, response);
    return response;
  }

  private executeAgents(
    params: Extract<SubagentToolParams, { action: 'agents' }>,
    ctx: ExtensionContext,
  ): AgentToolResult<SubagentToolDetails> {
    const cwd = params.cwd ?? ctx.cwd;
    const scope = scopeOrDefault(params.scope);
    if (!params.name) {
      const result = this.discovery.discover(cwd, scope);
      return textResult(formatAgentList(result.agents), { agents: result.agents.map(publicAgent) });
    }
    const agent = this.discovery.find(cwd, scope, params.name);
    if (!agent) {
      const candidates = this.discovery
        .discover(cwd, scope)
        .agents.map((candidate) => candidate.name)
        .toSorted();
      throw new DoomTeamExpectedError(
        'agent_not_found',
        `No executable agent matches '${params.name}'.${candidates.length ? ` Available: ${candidates.join(', ')}.` : ''}`,
        false,
        'Call subagent({"action":"agents"}) and retry with an exact name.',
      );
    }
    return textResult(formatAgentDetail(agent), { agent: publicAgent(agent) });
  }

  private async executeManagement(
    params: Exclude<SubagentToolParams, { action: 'run' } | { action: 'agents' }>,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    preallocatedRunIds?: string[],
    operationId?: string,
  ): Promise<AgentToolResult<SubagentToolDetails>> {
    const jobs = this.tracker.forSession(ctx.sessionManager.getSessionId());
    switch (params.action) {
      case SUBAGENT_ACTIONS.status: {
        const suspendedRuns = listSuspendedRuns(requireCurrentSessionScope());
        if (!('id' in params)) {
          if ('transcriptLines' in params && params.transcriptLines !== undefined) {
            throw invalidRequest(
              'transcriptLines requires a run id.',
              'Add id or omit transcriptLines for fleet status.',
            );
          }
          const runs = jobs.list();
          return textResult(formatFleetView(runs, Date.now(), suspendedRuns), {
            fleet: runs,
            suspended: suspendedRuns.map(publicSuspendedRun),
          });
        }
        const runId = params.id;
        if (!runId) {
          throw invalidRequest(
            'transcriptLines requires a run id.',
            'Add id or omit transcriptLines for fleet status.',
          );
        }
        const suspended = suspendedRuns.find((run) => run.runId === runId);
        if (suspended && params.transcriptLines === undefined) {
          const resumable = isSuspendedRunResumable(suspended);
          const recovery = resumable
            ? `Restore it with { action: "restore", id: "${suspended.runId}" }.`
            : 'It is not resumable; submit a new explicit run.';
          return textResult(`Run '${suspended.runId}' is suspended. ${recovery}`, {
            suspended: publicSuspendedRun(suspended),
          });
        }
        const result: StatusActionResult = this.management.status(runId);
        if (!result.runDir && !result.resultPath && !suspended) {
          throw new DoomTeamExpectedError(
            'run_not_found',
            `No run matches '${runId}'.`,
            false,
            'Call subagent({"action":"status"}) and retry with an exact id.',
          );
        }
        if (params.transcriptLines !== undefined) {
          return textResult(formatRunTranscript(result.status, params.transcriptLines ?? DEFAULT_TRANSCRIPT_LINES), {
            transcript: { runId: result.runId },
          });
        }
        return textResult(
          result.status ? `Run '${result.runId}': ${result.status.state}` : `Run '${result.runId}' has no status yet.`,
          { status: result },
        );
      }
      case SUBAGENT_ACTIONS.stop: {
        const id = resolveTrackedRunId(jobs, params.id);
        const result = this.management.stop(id, params.reason);
        return textResult(`Stop requested for '${id}'.`, { control: result });
      }
      case SUBAGENT_ACTIONS.steer: {
        const id = resolveTrackedRunId(jobs, params.id);
        const runtime = this.tracker.get(id)?.runtime;
        if (runtime && !isPiRuntime(runtime)) {
          throw new DoomTeamExpectedError(
            'unsupported_operation',
            `Run '${id}' uses '${runtime}', which does not support steering.`,
            false,
            `Use subagent({"action":"stop","id":"${id}"}) to terminate it.`,
          );
        }
        const result = await this.management.steer(id, params.message, undefined, signal);
        return textResult(`Steer request '${result.requestId}' for '${id}' is ${result.state}: ${result.message}`, {
          steer: result,
        });
      }
      case SUBAGENT_ACTIONS.suspended: {
        const runs = listSuspendedRuns(requireCurrentSessionScope());
        return textResult(runs.length ? formatSuspendedRuns(runs) : 'No suspended subagents in this session.', {
          suspended: runs.map(publicSuspendedRun),
        });
      }
      case SUBAGENT_ACTIONS.restore: {
        const scope = requireCurrentSessionScope();
        const record = listSuspendedRuns(scope).find((run) => run.runId === params.id);
        if (!record) {
          throw new DoomTeamExpectedError(
            'run_not_found',
            `No suspended run matches '${params.id}'.`,
            false,
            'Call subagent({"action":"suspended"}) and retry with an exact id.',
          );
        }
        if (!isSuspendedRunResumable(record)) {
          throw new DoomTeamExpectedError(
            'not_resumable',
            `Suspended run '${params.id}' does not have complete, readable Pi recovery state.`,
            false,
            'Submit a new explicit run request instead of restoring this record.',
          );
        }
        const result = this.trackOutcomes(
          await this.planner.spawn(
            {
              single: {
                agent: record.agent,
                ...(record.inlineAgent ? { inlineAgent: record.inlineAgent } : {}),
                task: record.task,
                cwd: record.cwd,
                ...(record.model ? { model: record.model } : {}),
                sessionFile: record.sessionFile,
              },
              cwd: record.cwd,
              agentScope: 'both',
              runtime: 'pi',
              availableModels: authenticatedModelInfos(ctx.modelRegistry),
              ...(operationId ? { operationId } : {}),
              ...(preallocatedRunIds ? { preallocatedRunIds } : {}),
            },
            loadConfig().config,
          ),
          ctx,
        );
        const outcome = result.outcomes[0];
        if (!outcome?.runId) {
          throw new DoomTeamExpectedError(
            'not_resumable',
            `Could not restore '${params.id}': ${outcome?.error ?? 'the spawn produced no run.'}`,
            true,
            'Inspect suspended state, then submit a new explicit run if recovery is not possible.',
          );
        }
        clearSuspendedRun(scope, params.id);
        return textResult(`Restored '${params.id}' as '${outcome.runId}', continuing its transcript.`, {
          restore: { ...outcome, restoredFrom: params.id },
        });
      }
    }
  }

  private buildTool(): ToolDefinition<typeof SubagentParams, SubagentToolDetails> {
    return {
      name: SUBAGENT_TOOL_NAME,
      label: 'Subagent',
      description: SUBAGENT_TOOL_DESCRIPTION,
      parameters: SubagentParams,
      prepareArguments: validateParams,
      // Subagent output carries explicit lifecycle colors. Owning the shell keeps
      // Pi's broad pending/success/error backgrounds from washing out long lists.
      renderShell: 'self',
      renderCall: (rawParams, theme) => renderSubagentCall(validateParams(rawParams), theme),
      renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
      execute: async (id, rawParams, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentToolDetails>> => {
        const params = validateParams(rawParams);
        const progress = progressMessage(params);
        if (progress) onUpdate?.(progressResult(progress, params.action));
        if (params.action === SUBAGENT_ACTIONS.run) return this.executeRun(id, params, ctx);
        if (params.action === SUBAGENT_ACTIONS.agents) return this.executeAgents(params, ctx);
        const journaled =
          params.action === SUBAGENT_ACTIONS.steer ||
          params.action === SUBAGENT_ACTIONS.stop ||
          params.action === SUBAGENT_ACTIONS.restore;
        if (!journaled) return this.executeManagement(params, ctx, signal);

        const operation = startOperation<AgentToolResult<SubagentToolDetails>>(
          id,
          params,
          params.action === SUBAGENT_ACTIONS.restore ? [randomUUID()] : [],
        );
        if (operation.kind === 'replay') {
          if (operation.record.state === 'completed' && operation.record.result) return operation.record.result;
          throw new DoomTeamExpectedError(
            'delivery_unconfirmed',
            `Operation '${id}' is already pending.`,
            true,
            'Inspect run status before retrying this control operation.',
          );
        }
        const response = await this.executeManagement(params, ctx, signal, operation.record.runIds, id);
        completeOperation(id, operation.record, response);
        return response;
      },
    };
  }
}
