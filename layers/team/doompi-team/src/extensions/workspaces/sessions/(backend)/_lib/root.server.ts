import { DOOM_BACKGROUND_WORK_SERVICE } from '@agimon-ai/doompi-core/background-work';
import { readDoomChildSessionService } from '@agimon-ai/doompi-core/child';
import { DOOM_DELEGATION_SERVICE } from '@agimon-ai/doompi-core/delegation';
import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomHeadlessActivity } from '@agimon-ai/doompi-core/headless';
import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hub-channel';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';

import { DOOM_SUBAGENT_POLICY_SERVICE } from '../../../../../schemas/subagentPolicy';
import { resolveActiveTeamModelSpecs } from '../../../../../services/agentDiscovery';
import type { NativeAsyncJobProjection, TrackedAsyncJob } from '../../../../../services/asyncJobTracker';
import { createBackgroundWorkService } from '../../../../../services/backgroundWorkService';
import { loadConfig } from '../../../../../services/config';
import { createDelegationBridge } from '../../../../../services/delegationBridge';
import { registerDirectRunBackgroundWork } from '../../../../../services/directRunBackgroundWork';
import { toModelInfo } from '../../../../../services/modelInfo';
import { nativeRunProjection } from '../../../../../services/nativeRunProjection';
import { subscribeNativeRunProjection } from '../../../../../services/nativeRunProjection';
import type { NativeTeamTransport } from '../../../../../services/nativeTeamChannel';
import { openScopeAsync, suspendScopeRuns } from '../../../../../services/sessionLifecycle';
import { createSessionScope } from '../../../../../services/sessionPaths';
import { createSubagentPolicyService } from '../../../../../services/subagentPolicyService';
import { formatSuspendedRuns } from '../../../../../services/suspendedRuns';
import { createTeamExtensionRuntime } from '../../../../../services/teamRuntime';
import { catalogModels, presentCatalog } from '../../../../../services/webSubagentCatalog';
import {
  SUBAGENT_CATALOG_TYPE,
  SUBAGENT_RUNS_TYPE,
  type SubagentRun,
  type SubagentRunState,
} from '../../../../../types/webSubagents';

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

const root = defineRoot(({ context, host: serverHost, agent: host }: DoomServerPluginContext) => {
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
  const jobs = runtime.asyncJobTracker.forSession(execution.sessionId, scope);
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
  const serverService = (ctx: Context) => {
    ctx.plugin((providerContext) => {
      const availableModels = execution.model ? [toModelInfo(execution.model)] : [];
      providerContext.provide(
        DOOM_DELEGATION_SERVICE,
        bridge.createService(providerContext, {
          sessionId: execution.sessionId,
          sessionScope: createSessionScope(execution.sessionId),
          availableModels,
          ...(execution.model ? { parentModel: execution.model } : {}),
        }),
      );
      const backgroundWork = createBackgroundWorkService(providerContext);
      providerContext.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWork);
      registerDirectRunBackgroundWork(providerContext, backgroundWork, execution.sessionId, runtime.asyncJobTracker);
      providerContext.provide(DOOM_SUBAGENT_POLICY_SERVICE, createSubagentPolicyService(runtime.capabilityPolicies));
    });
  };

  const environment = serverHost.context.environment;
  const activity: DoomHeadlessActivity = {
    name: '@agimon-ai/doompi-team',
    async start(activityContext) {
      const nativeRuns = new Map<string, NativeAsyncJobProjection>();
      const publishRunSnapshot = (): void => publishRuns(directEvents, execution.sessionId, jobs.list(), nativeRuns);
      const cleanups = [
        runtime.asyncJobTracker.subscribe(execution.sessionId, publishRunSnapshot),
        subscribeNativeRunProjection(execution.sessionId, (runs) => {
          nativeRuns.clear();
          for (const run of runs) nativeRuns.set(run.runId, run);
          publishRunSnapshot();
        }),
      ];
      publishRunSnapshot();
      try {
        const discovered = runtime.discovery.discover(execution.cwd, 'both').agents;
        directEvents.publish(SUBAGENT_CATALOG_TYPE, execution.sessionId, {
          cwd: execution.cwd,
          agents: presentCatalog(discovered),
          models: catalogModels(discovered, resolveActiveTeamModelSpecs(environment) ?? []),
        });
      } catch (error) {
        directEvents.publish(SUBAGENT_CATALOG_TYPE, execution.sessionId, {
          cwd: execution.cwd,
          agents: [],
          models: [],
          warning: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        const opened = await openScopeAsync(scope);
        if (opened.suspended.length)
          await activityContext.client.notify({ body: formatSuspendedRuns(opened.suspended), level: 'info' });
        channel.bindMainSession(activityContext.sessionId);
        return () => {
          for (const cleanup of cleanups.reverse()) cleanup();
          channel.dispose();
        };
      } catch (error) {
        for (const cleanup of cleanups.reverse()) cleanup();
        throw error;
      }
    },
  };

  return {
    value: {
      runtime,
      execution,
      scope,
      jobs,
      bridge,
      channel,
      directEvents,
      environment: serverHost.context.environment,
    },
    services: [serverService],
    activities: [activity],
    async onDispose() {
      channel.dispose();
      runtime.completionNotifier.dispose();
      const suspension = suspendScopeRuns({
        scope,
        reason: 'headless session ended',
        jobs: jobs.list(),
        stop: (runId, reason) => runtime.management.stop(runId, reason),
      });
      const nativeShutdown = runtime.nativeRuns.close().finally(() => nativeRunProjection.dispose(execution.sessionId));
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
  };
});

export type TeamServerScope = Awaited<ReturnType<typeof root>>['value'];
export default root;
