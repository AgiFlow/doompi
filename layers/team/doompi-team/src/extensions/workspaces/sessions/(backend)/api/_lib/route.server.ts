import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomApi, DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { AgentDiscoveryService, resolveActiveTeamModelSpecs } from '../../../../../../services/agentDiscovery';
import { loadConfig } from '../../../../../../services/config';
import { DoomTeamExpectedError } from '../../../../../../services/errors';
import type { ControlActionResult, SteerActionResult } from '../../../../../../services/managementActions';
import { toModelInfo } from '../../../../../../services/modelInfo';
import { createSessionScope } from '../../../../../../services/sessionPaths';
import type { TeamExtensionRuntime } from '../../../../../../services/teamRuntime';
import { catalogModels, presentCatalog, type CatalogAgentInput } from '../../../../../../services/webSubagentCatalog';
import type { TeamServerScope } from '../../_lib/root.server';

export const TEAM_API_BASE_PATH = 'team';
export const TEAM_CATALOG_ROUTE = '/catalog';
export const TEAM_RUN_ROUTE = '/run';
export const TEAM_STEER_ROUTE = '/steer';
export const TEAM_STOP_ROUTE = '/stop';

export interface TeamRunRequest {
  agent: string;
  task: string;
  fork: boolean;
  model?: string;
}

export interface TeamSteerRequest {
  runId: string;
  message: string;
}

export interface TeamStopRequest {
  runId: string;
}

export interface TeamCatalogSnapshot {
  agents: CatalogAgentInput[];
  models: string[];
}

export interface TeamApiOptions {
  cwd: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  read?: (cwd: string) => TeamCatalogSnapshot;
  launch?: (request: TeamRunRequest) => Promise<{ runId: string }>;
  steer?: (request: TeamSteerRequest, signal: AbortSignal) => Promise<SteerActionResult>;
  stop?: (request: TeamStopRequest) => Promise<ControlActionResult>;
}

function isRunRequest(value: unknown): value is TeamRunRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.agent === 'string' &&
    request.agent.trim() !== '' &&
    typeof request.task === 'string' &&
    typeof request.fork === 'boolean' &&
    (request.model === undefined || (typeof request.model === 'string' && request.model.trim() !== '')) &&
    Object.keys(request).every((key) => ['agent', 'task', 'fork', 'model'].includes(key))
  );
}

function isSteerRequest(value: unknown): value is TeamSteerRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.runId === 'string' &&
    request.runId.trim() !== '' &&
    typeof request.message === 'string' &&
    request.message.trim() !== '' &&
    Object.keys(request).every((key) => ['runId', 'message'].includes(key))
  );
}

function isStopRequest(value: unknown): value is TeamStopRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.runId === 'string' &&
    request.runId.trim() !== '' &&
    Object.keys(request).every((key) => key === 'runId')
  );
}

/** The typed error's text carries a recovery hint written for the model, so a missing run gets a sentence for people. */
function controlFailure(error: unknown): Response {
  if (error instanceof DoomTeamExpectedError && error.code === 'run_not_found')
    return Response.json({ error: 'This run is not active.' }, { status: 404 });
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
}

/** Serves catalog discovery, run launch, and run steer and stop from the selected session process, never through a parent prompt. */
export function createTeamApiHandler(options: TeamApiOptions): DoomApiHandler {
  const discovery = new AgentDiscoveryService(options.environment);
  const read =
    options.read ??
    ((cwd: string): TeamCatalogSnapshot => ({
      agents: discovery.discover(cwd, 'both').agents,
      models: resolveActiveTeamModelSpecs(options.environment) ?? [],
    }));

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === TEAM_RUN_ROUTE && options.launch) {
        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return Response.json({ error: 'Invalid run request.' }, { status: 400 });
        }
        if (!isRunRequest(input)) return Response.json({ error: 'Invalid run request.' }, { status: 400 });
        try {
          return Response.json(await options.launch(input), { status: 201 });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
        }
      }
      if (request.method === 'POST' && url.pathname === TEAM_STEER_ROUTE && options.steer) {
        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return Response.json({ error: 'Invalid steer request.' }, { status: 400 });
        }
        if (!isSteerRequest(input)) return Response.json({ error: 'Invalid steer request.' }, { status: 400 });
        try {
          return Response.json(
            await options.steer({ runId: input.runId.trim(), message: input.message.trim() }, request.signal),
          );
        } catch (error) {
          return controlFailure(error);
        }
      }
      if (request.method === 'POST' && url.pathname === TEAM_STOP_ROUTE && options.stop) {
        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return Response.json({ error: 'Invalid stop request.' }, { status: 400 });
        }
        if (!isStopRequest(input)) return Response.json({ error: 'Invalid stop request.' }, { status: 400 });
        try {
          return Response.json(await options.stop({ runId: input.runId.trim() }));
        } catch (error) {
          return controlFailure(error);
        }
      }
      if (request.method !== 'GET' || url.pathname !== TEAM_CATALOG_ROUTE) {
        return Response.json({ error: 'Not found.' }, { status: 404 });
      }
      try {
        discovery.invalidate();
        const snapshot = read(options.cwd);
        return Response.json({
          cwd: options.cwd,
          agents: presentCatalog(snapshot.agents),
          models: catalogModels(snapshot.agents, snapshot.models),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 500 });
      }
    },
    close: () => undefined,
  };
}

/** One mounted session API, backed by the Team runtime that owns the subagent tool. */
export function createTeamSessionApi(runtime: TeamExtensionRuntime, execution: DoomHeadlessExecutionContext): DoomApi {
  const scope = createSessionScope(execution.sessionId);
  const jobs = runtime.asyncJobTracker.forSession(execution.sessionId, scope);

  const launch = async (request: TeamRunRequest): Promise<{ runId: string }> => {
    const parentForkSource = request.fork ? await execution.session.forkSource?.() : undefined;
    if (request.fork && !parentForkSource) throw new Error('This session cannot capture a fork source.');
    const plan = await runtime.spawnPlanner.spawn(
      {
        single: {
          agent: request.agent.trim(),
          task: request.task.trim(),
          context: request.fork ? 'fork' : 'fresh',
          ...(request.model ? { model: request.model } : {}),
        },
        cwd: execution.cwd,
        agentScope: 'both',
        sessionScope: scope,
        environment: execution.environment,
        parentSessionId: execution.sessionId,
        ...(parentForkSource ? { parentForkSource } : {}),
        availableModels: execution.model ? [toModelInfo(execution.model)] : [],
        ...(execution.model ? { parentModel: execution.model } : {}),
      },
      loadConfig().config,
    );
    const outcome = plan.outcomes[0];
    if (!outcome?.runId) throw new Error(outcome?.error ?? 'The agent did not start.');
    jobs.track(
      outcome.runId,
      outcome.identity ? { identity: outcome.identity, inline: outcome.inline ?? false } : undefined,
    );
    return { runId: outcome.runId };
  };

  return {
    basePath: TEAM_API_BASE_PATH,
    start: () =>
      createTeamApiHandler({
        cwd: execution.cwd,
        environment: execution.environment,
        launch,
        steer: (request, signal) => runtime.management.steer(request.runId, request.message, undefined, signal),
        stop: (request) => runtime.management.stop(request.runId),
      }),
  };
}

export default (context: WithRoot<DoomServerPluginContext, TeamServerScope>) =>
  createTeamSessionApi(context.root.runtime, context.root.execution);
