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
import { formatCompletionHeadline, SUBAGENT_NOTIFY_MESSAGE_TYPE } from '../../../../../services/notify';
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

  // Three jobs the Pi facet gets from one `ExtensionAPI.sendMessage`, which a
  // headless session has to do by hand:
  //
  //   toast      `client.notify` - operator-facing only. It writes a
  //              `doom-notification` custom entry whose body is flattened to a
  //              single line and capped at 4096 characters, and the model never
  //              sees custom entries. So it gets a headline, not the result.
  //   transcript `session.appendCustomEntry` - the durable record, under the
  //              same custom type the TUI renderer uses, with the full
  //              multi-line content and the structured details.
  //   wake       `session.admitPrompt(content, 'steer')` - the only call that
  //              puts the completion in front of the model. 'steer' means "how
  //              to deliver if a turn is running"; an idle agent is woken
  //              either way. `session.prompt(_, 'steer')` would NOT do this: it
  //              is enqueue-only and parks the message on an idle lane.
  //
  // Serialised through one tail promise. Failures bypass the notifier's batcher
  // (`services/notify`), so two runs failing in the same tick produce two
  // deliveries; sequencing them keeps each one observing settled lane state.
  let deliveries: Promise<void> = Promise.resolve();
  runtime.completionNotifier.attachHost({
    sendMessage: (message, options) => {
      const details = message.details ?? [];
      const headline = details.length > 0 ? formatCompletionHeadline(details) : message.content;
      const failed = details.some((detail) => detail.status !== 'completed');
      const delivery = deliveries.then(async () => {
        await execution.client.notify({ body: headline, level: failed ? 'warning' : 'info' });
        await execution.session.appendCustomEntry(SUBAGENT_NOTIFY_MESSAGE_TYPE, {
          content: message.content,
          details,
        });
        // `triggerTurn: false` has no faithful headless mapping: there is no
        // way to put text in model context without starting or joining a turn
        // (`appendCustomEntry` is journal-only). Keep today's behaviour - the
        // operator sees it, the model does not wake - rather than guessing.
        if (options?.triggerTurn === false) return;
        // Matching the voice facet, which also refuses rather than degrading:
        // `session.prompt(_, 'steer')` is NOT a fallback here, because it is
        // enqueue-only and would park the completion on an idle lane - the
        // original bug. Refusing surfaces as non-delivery, which keeps
        // `ResultWatcher`'s claim alive for a retry.
        if (!execution.session.admitPrompt) throw new Error('The session cannot admit a completion prompt.');
        await execution.session.admitPrompt(message.content, 'steer');
      });
      // The notifier reports non-delivery on a rejection, which keeps
      // `ResultWatcher`'s claim alive for a retry. The tail must not inherit
      // that rejection, or one failed completion would poison every later one.
      deliveries = delivery.catch(() => undefined);
      return delivery;
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
    // Mirrors `root.cli.ts`, which starts the scheduler in its own `onStart`.
    // Without this the delegation bridge's progress subscription never ticks
    // and `scheduler.wake()` is a no-op, so the pre-timeout nudge a long
    // delegation gets in the TUI never fires headless. `onDispose` below
    // already stops it; this is the missing half of that pair.
    onStart() {
      runtime.pollScheduler.start();
    },
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
