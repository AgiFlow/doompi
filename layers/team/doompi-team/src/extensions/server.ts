import { DOOM_BACKGROUND_WORK_SERVICE } from '@agimon-ai/doompi-core/background-work';
import { readDoomChildSessionService } from '@agimon-ai/doompi-core/child';
import { DOOM_DELEGATION_SERVICE } from '@agimon-ai/doompi-core/delegation';
import {
  type DoomHeadlessExecutionContext,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hub-channel';
import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';

import { createTeamSessionApi } from '../controllers/teamSessionApi';
import { createSubagentCatalogChannel } from '../controllers/webSubagentCatalogChannel';
import { createSubagentsChannel } from '../controllers/webSubagentsChannel';
import { DOOM_SUBAGENT_POLICY_SERVICE } from '../schemas/subagentPolicy';
import { SUBAGENT_ACTIONS, SubagentParams, type SubagentToolParams } from '../schemas/subagentTool';
import { resolveActiveTeamModelSpecs } from '../services/agentDiscovery';
import type { NativeAsyncJobProjection, TrackedAsyncJob } from '../services/asyncJobTracker';
import { resolveTrackedRunId } from '../services/asyncJobTracker';
import { createBackgroundWorkService } from '../services/backgroundWorkService';
import { loadConfig } from '../services/config';
import { createDelegationBridge } from '../services/delegationBridge';
import { DoomTeamExpectedError } from '../services/errors';
import { toModelInfo } from '../services/modelInfo';
import { subscribeNativeRunProjection } from '../services/nativeRunProjection';
import { nativeRunProjection } from '../services/nativeRunProjection';
import type { NativeTeamRuntime, NativeTeamTransport } from '../services/nativeTeamChannel';
import { openScopeAsync, suspendScopeRuns } from '../services/sessionLifecycle';
import { createSessionScope } from '../services/sessionPaths';
import { createSubagentPolicyService } from '../services/subagentPolicyService';
import {
  clearSuspendedRun,
  formatSuspendedRuns,
  isSuspendedRunResumable,
  listSuspendedRuns,
} from '../services/suspendedRuns';
import { createTeamExtensionRuntime } from '../services/teamRuntime';
import { catalogModels, presentCatalog } from '../services/webSubagentCatalog';
import {
  SUBAGENT_CATALOG_TYPE,
  SUBAGENT_RUNS_TYPE,
  type SubagentRun,
  type SubagentRunState,
} from '../types/webSubagents';

const SOURCE = '@agimon-ai/doompi-team';
const SUBAGENT_DESCRIPTION =
  'Discover agents, start and manage persistent background subagent runs, and inspect suspended work.';

interface SessionRunProjection extends SubagentRun {
  /** Host-private child transcript path consumed by the hub, not the browser. */
  sessionFile?: string;
}

const TERMINAL_RUN_STATES = new Set(['completed', 'complete', 'failed', 'stopped', 'paused']);

function runState(status: string): SubagentRunState {
  if (status === 'completed' || status === 'complete') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'stopped' || status === 'paused') return 'stopped';
  if (status === 'queued') return 'queued';
  return 'running';
}

function presentTrackedRun(run: TrackedAsyncJob): SessionRunProjection | undefined {
  if (!run.agent || !run.status || run.startedAt === undefined) return undefined;
  const lastUpdate = run.updatedAt ?? run.startedAt;
  return {
    runId: run.runId,
    agent: run.agent,
    state: runState(run.status),
    rawState: run.status,
    task: run.task ?? '',
    cwd: run.cwd ?? '',
    startedAt: run.startedAt,
    ...(TERMINAL_RUN_STATES.has(run.status) ? { endedAt: lastUpdate } : {}),
    lastUpdate,
    tail: [],
    ...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
    ...(run.summary === undefined ? {} : { summary: run.summary }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function presentNativeRun(run: NativeAsyncJobProjection): SessionRunProjection {
  return {
    runId: run.runId,
    agent: run.agent,
    state: runState(run.status),
    rawState: run.status,
    task: run.task,
    cwd: run.cwd,
    startedAt: run.startedAt,
    ...(TERMINAL_RUN_STATES.has(run.status) ? { endedAt: run.updatedAt } : {}),
    lastUpdate: run.updatedAt,
    tail: [],
    ...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
    ...(run.summary === undefined ? {} : { summary: run.summary }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function publishRuns(
  directEvents: DoomDirectEventBus,
  sessionId: string,
  jobs: readonly TrackedAsyncJob[],
  nativeRuns: ReadonlyMap<string, NativeAsyncJobProjection>,
): void {
  const runs = jobs
    .filter((job) => !job.native)
    .map(presentTrackedRun)
    .filter((run): run is SessionRunProjection => run !== undefined);
  runs.push(...[...nativeRuns.values()].map(presentNativeRun));
  directEvents.publish(SUBAGENT_RUNS_TYPE, sessionId, { runs });
}

function result(value: unknown, isError = false): DoomHeadlessToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], details: value, ...(isError ? { isError: true } : {}) };
}

function scopeOf(value: string | undefined): 'user' | 'project' | 'both' {
  return value === 'user' || value === 'project' ? value : 'both';
}

type HeadlessTeamServicesConfig = {
  readonly bridge: ReturnType<typeof createDelegationBridge>;
  readonly runtime: ReturnType<typeof createTeamExtensionRuntime>;
  readonly execution: DoomHeadlessExecutionContext;
};

function subagentTool(
  runtime: ReturnType<typeof createTeamExtensionRuntime>,
  execution: DoomHeadlessExecutionContext,
): DoomHeadlessTool<typeof SubagentParams> {
  const scope = createSessionScope(execution.sessionId);
  const jobs = runtime.asyncJobTracker.forSession(execution.sessionId, scope);
  const availableModels = execution.model ? [toModelInfo(execution.model)] : [];
  return {
    name: 'subagent',
    label: 'Subagent',
    description: SUBAGENT_DESCRIPTION,
    parameters: SubagentParams,
    promptSnippet: 'Discover, run, inspect, steer, stop, and restore persistent subagents',
    promptGuidelines: [
      'Runs are persistent background work. Do not resubmit a run that already returned an id.',
      'Use status or suspended before retrying a failed or interrupted operation.',
    ],
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal, onUpdate) {
      if (!Check(SubagentParams, parameters)) return result('Invalid subagent parameters.', true);
      const params = parameters as SubagentToolParams;
      try {
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
          return result({
            agents: selected
              ? [selected]
              : agents.map((agent) => ({
                  name: agent.name,
                  source: agent.source,
                  description: agent.description,
                  runtime: agent.runtime ?? 'pi',
                })),
          });
        }
        if (params.action === SUBAGENT_ACTIONS.run) {
          onUpdate?.(
            result(`Starting ${params.requests.length} subagent${params.requests.length === 1 ? '' : 's'}...`),
          );
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
            },
            loadConfig().config,
          );
          for (const outcome of plan.outcomes) if (outcome.runId) jobs.track(outcome.runId);
          return result(plan);
        }
        if (params.action === SUBAGENT_ACTIONS.status) {
          if (!('id' in params)) return result({ runs: jobs.list() });
          const status = runtime.management.status(params.id);
          return result({ runId: status.runId, status: status.status });
        }
        if (params.action === SUBAGENT_ACTIONS.suspended) {
          const suspended = listSuspendedRuns(createSessionScope(execution.sessionId));
          return result({
            suspended,
            text: suspended.length ? formatSuspendedRuns(suspended) : 'No suspended subagents in this session.',
          });
        }
        const id = resolveTrackedRunId(jobs, params.id);
        if (params.action === SUBAGENT_ACTIONS.stop) {
          return result({ runId: id, control: await runtime.management.stop(id, params.reason) });
        }
        if (params.action === SUBAGENT_ACTIONS.steer) {
          const steer = await runtime.management.steer(id, params.message, undefined, signal);
          return result({ runId: id, steer });
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
        return result({ restore: { ...outcome, restoredFrom: params.id } });
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}

function intercomTool(channel: NativeTeamRuntime): DoomHeadlessTool {
  return {
    name: 'intercom',
    label: 'Intercom',
    description: 'Communicate with active agents in this root session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['members', 'send', 'ask', 'pending', 'reply'] },
        to: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      required: ['action'],
    },
    executionMode: 'serial',
    async execute(toolCallId, parameters, signal, onUpdate) {
      return channel.execute(toolCallId, parameters, signal, onUpdate);
    },
  };
}

export const teamServerFacet = defineServerPlugin({
  name: SOURCE,
  global: { channels: [createSubagentsChannel, createSubagentCatalogChannel] },
  workspace: { channels: [createSubagentsChannel, createSubagentCatalogChannel] },
  session: ({ context, host: serverHost, agent: host }) => {
    /** Mount Team's session services under a Cordis-owned plugin fiber. */
    function headlessTeamServicesPlugin(ctx: Context, config: HeadlessTeamServicesConfig): void {
      const availableModels = config.execution.model ? [toModelInfo(config.execution.model)] : [];
      ctx.provide(
        DOOM_DELEGATION_SERVICE,
        config.bridge.createService(ctx, {
          sessionId: config.execution.sessionId,
          sessionScope: createSessionScope(config.execution.sessionId),
          availableModels,
          ...(config.execution.model ? { parentModel: config.execution.model } : {}),
        }),
      );
      ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, createBackgroundWorkService(ctx));
      ctx.provide(DOOM_SUBAGENT_POLICY_SERVICE, createSubagentPolicyService(config.runtime.capabilityPolicies));
    }

    if (!host) throw new Error('Team session requires the headless host.');
    if (serverHost.context.environment === undefined) {
      throw new Error('Team headless facet requires an admitted session environment.');
    }
    const directEvents = serverHost.context.directEvents;
    if (directEvents === undefined) {
      throw new Error('Team headless facet requires host-owned direct events.');
    }
    const execution = host.context;
    const runtime = createTeamExtensionRuntime(undefined, {
      environment: serverHost.context.environment,
      childSessions: { get: () => readDoomChildSessionService(context) },
      nativeRunProjection,
    });
    const scope = createSessionScope(execution.sessionId);
    runtime.management.bindSessionScope(scope);
    const directEventCleanups: Array<() => void> = [];
    const jobs = runtime.asyncJobTracker.forSession(execution.sessionId, scope);
    const nativeRuns = new Map<string, NativeAsyncJobProjection>();
    const publishRunSnapshot = (): void => publishRuns(directEvents, execution.sessionId, jobs.list(), nativeRuns);
    directEventCleanups.push(runtime.asyncJobTracker.subscribe(execution.sessionId, publishRunSnapshot));
    directEventCleanups.push(
      subscribeNativeRunProjection(execution.sessionId, (runs) => {
        nativeRuns.clear();
        for (const run of runs) nativeRuns.set(run.runId, run);
        publishRunSnapshot();
      }),
    );
    publishRunSnapshot();
    try {
      const discovered = runtime.discovery.discover(execution.cwd, 'both').agents;
      directEvents.publish(SUBAGENT_CATALOG_TYPE, execution.sessionId, {
        cwd: execution.cwd,
        agents: presentCatalog(discovered),
        models: catalogModels(discovered, resolveActiveTeamModelSpecs(serverHost.context.environment) ?? []),
      });
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      directEvents.publish(SUBAGENT_CATALOG_TYPE, execution.sessionId, {
        cwd: execution.cwd,
        agents: [],
        models: [],
        warning,
      });
    }
    const bridge = createDelegationBridge({
      planner: runtime.spawnPlanner,
      management: runtime.management,
      waiter: runtime.subagentWaiter,
      scheduler: runtime.pollScheduler,
      tracker: runtime.asyncJobTracker,
      loadConfig: () => loadConfig().config,
    });

    runtime.completionNotifier.attachHost({
      sendMessage: (message) => {
        const pending = execution.client.notify({ body: message.content, level: 'info' });
        if (pending)
          void pending.catch((error) =>
            process.emitWarning(`Could not notify headless Team completion: ${String(error)}`),
          );
      },
    });
    const transport: NativeTeamTransport = {
      sendMessage: ((message) =>
        void execution.client.notify({
          body:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) => ('text' in part ? part.text : '[image]')).join('\n'),
          level: 'info',
        })) as NativeTeamTransport['sendMessage'],
      sendUserMessage: ((message) =>
        void execution.session.prompt(
          typeof message === 'string'
            ? message
            : message.map((part) => ('text' in part ? part.text : '[image]')).join('\n'),
          'steer',
        )) as NativeTeamTransport['sendUserMessage'],
    };
    const channel = runtime.teamChannel.createHeadlessRuntime(transport);
    return {
      api: [createTeamSessionApi(runtime, execution)],
      services: [(ctx: Context) => headlessTeamServicesPlugin(ctx, { bridge, runtime, execution })],
      async onDispose() {
        for (const cleanup of directEventCleanups.splice(0).reverse()) cleanup();
        channel.dispose();
        runtime.completionNotifier.dispose();
        const suspension = suspendScopeRuns({
          scope,
          reason: 'headless session ended',
          jobs: jobs.list(),
          stop: (runId, reason) => runtime.management.stop(runId, reason),
        });
        const nativeShutdown = runtime.nativeRuns
          .close()
          .finally(() => nativeRunProjection.dispose(execution.sessionId));
        const outcomes = await Promise.allSettled([suspension, nativeShutdown]);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected')
            process.emitWarning(`Could not shut down headless Team runs: ${String(outcome.reason)}`);
        }
        bridge.abandonAll();
        runtime.dispose();
        runtime.asyncJobTracker.stop();
        runtime.pollScheduler.stop();
      },
      tools: [subagentTool(runtime, execution), intercomTool(channel)],
      resources: [
        {
          name: 'doompi/team',
          kind: 'context',
          read: () =>
            JSON.stringify(
              { sessionId: execution.sessionId, members: channel.current() ? [channel.current()] : [] },
              null,
              2,
            ),
        },
      ],
      activities: [
        {
          name: SOURCE,
          async start(activityContext) {
            const opened = await openScopeAsync(scope);
            if (opened.suspended.length)
              await activityContext.client.notify({ body: formatSuspendedRuns(opened.suspended), level: 'info' });
            channel.bindMainSession(activityContext.sessionId);
            return () => {
              // Optional disable only detaches the communication member. Jobs and
              // their tracker remain available for a later activation.
              channel.dispose();
            };
          },
        },
      ],
    };
  },
});

export default teamServerFacet;
