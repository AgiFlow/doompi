/**
 * Install the Team feature into one package-local Cordis root.
 *
 * The standard Pi factory owns that root and disposes it when Pi emits
 * `session_shutdown`. Each factory invocation therefore creates fresh session
 * state; no process-global container or replacement-root handshake participates
 * in reload. Long-lived services are registered as Cordis effects, and stale
 * asynchronous session-start continuations are fenced by a generation token.
 */

import { resolveRootSessionId } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  requireDoomContextContributions,
} from '@agimon-ai/doompi-extension-contracts/context-contributions';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_MCP_TOOL_RESOLVER_SERVICE,
  requireDoomMcpToolResolver,
} from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import {
  createDoomReadinessCoordinator,
  type DoomReadinessCoordinator,
  type DoomReadinessHandle,
  type DoomReadinessNotification,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  registerSlashCommands,
  startSingleAgentRun,
  type SlashCommandDeps,
  type SlashCommandState,
} from './commands/slash/slashCommands';
import { loadConfig } from './extensions/config';
import { createDelegationBridge } from './extensions/delegationBridge';
import { createFablePlanBridge } from './extensions/fablePlanBridge';
import type { ManagementActionsContract } from './extensions/managementActions';
import { appendOrchestratorPrompt, shouldInjectOrchestratorPrompt } from './extensions/orchestratorPrompt';
import { captureSessionForkSource, type SpawnPlannerContract } from './extensions/spawnPlan';
import type { SkillDiscoveryContract } from '../agents/skills';
import type { AgentDiscoveryContract } from '../agents/types';
import { formatTeamContextSnapshot, readActiveTeamSnapshot } from '../api/teamSnapshot';
import {
  type AsyncJobTrackerContract,
  type TrackedAsyncJobsContract,
  TERMINAL_ASYNC_JOB_STATES,
} from '../asyncJobTracker';
import { openScopeAsync, suspendScopeRuns } from '../runs/registry/sessionLifecycle';
import { formatSuspendedRunsAsync } from '../suspendedRuns';
import { normalizeParentModel } from '../runs/shared/modelFallback';
import { authenticatedModelInfos } from '../../services/models/modelResolution';
import { createSessionScope, setCurrentSessionScope, tryCurrentSessionScope } from '../filesystem/paths';
import type { PollSchedulerContract } from '../pollScheduler';
import { writeScopeOwnerAsync } from '../scopeOwner';
import { resolveActiveTeamModelSpecs } from '../agents/discovery';
import { writeSessionCatalogSnapshot } from '../sessionCatalogSnapshot';
import { presentCatalog } from '../../services/webSubagentCatalog';
import { registerCompletionRenderer } from './tui/completionNotice';
import { registerSlashRunRenderer } from './tui/slashRunNotice';
import {
  registerAgentListCommand,
  registerAgentStatus,
  registerFleetCommand,
  registerSubagentLeaderContribution,
} from './tui/register';
import { teamCollaborationPlugin, type TeamDelegationObservation } from './collaboration';
import { createTeamExtensionRuntime, type TeamExtensionRuntime } from './teamRuntime';

/** See the subscriber's own comment for why crash detection does not need the 250ms floor. */
const STALE_RUN_RECONCILE_INTERVAL_MS = 2_000;
const SESSION_SHUTDOWN_REASON_FALLBACK = 'unknown';
const PACKAGE_SOURCE = '@agimon-ai/doompi-team';

type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0];
type CommandOptions = Parameters<ExtensionAPI['registerCommand']>[1];
type ShortcutOptions = Parameters<ExtensionAPI['registerShortcut']>[1];

function boundPiValue(target: ExtensionAPI, property: PropertyKey): unknown {
  const value = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

function readinessNotificationMessage(notification: DoomReadinessNotification): string {
  const diagnostics = notification.diagnostics.join('; ');
  const detail = (notification.error?.message ?? diagnostics) || 'Initialization did not complete.';
  return `${notification.packageId} initialization ${notification.state}: ${detail}`;
}

function buildSlashCommandDeps(
  discovery: AgentDiscoveryContract,
  skills: SkillDiscoveryContract,
  planner: SpawnPlannerContract,
  tracker: AsyncJobTrackerContract,
  scheduler: PollSchedulerContract,
  management: ManagementActionsContract,
): SlashCommandDeps {
  return {
    spawnPlanner: planner,
    tracker,
    scheduler,
    discovery,
    skills,
    management,
    loadConfig: () => loadConfig().config,
  };
}

function recordDelegationObservation(telemetry: DoomTelemetry, observation: TeamDelegationObservation): void {
  if (observation.kind === 'requested') {
    const { event } = observation;
    void telemetry.recordEvent('doom_team.delegation_requested', {
      'agent.name': event.agent,
      'task.id': event.taskId,
      mode: event.runMode ?? 'foreground',
    });
  } else if (observation.kind === 'started') {
    const { event } = observation;
    void telemetry.recordEvent('doom_team.child_started', { 'run.id': event.runId, outcome: 'started' });
  } else if (observation.kind === 'updated') {
    const { event } = observation;
    void telemetry.recordEvent('doom_team.delegation_updated', {
      'run.id': event.runId,
      'team.tool_count': event.toolCount ?? 0,
      'team.duration_ms': event.durationMs ?? 0,
      'team.token_count': event.tokens ?? 0,
      outcome: event.status ?? 'updated',
    });
  } else if (observation.kind === 'finished') {
    const { event } = observation;
    void telemetry.recordEvent('doom_team.delegation_finished', {
      'run.id': event.runId,
      'team.tool_count': event.toolCount ?? 0,
      'team.duration_ms': event.durationMs ?? 0,
      outcome: event.status,
    });
  } else {
    void telemetry.recordEvent('doom_team.delegation_cancelled', { outcome: 'cancelled' });
  }
}

/**
 * The extension factory pi's loader calls, exported as the module default
 * (see the override this file carries in `vibe-lint.config.yaml`). This is an
 * ESM `.ts` module, so it CANNOT use the `export =` form that
 * `subagentPromptRuntimeEntry.cts` is required to use - that file is `.cts`
 * and is resolved by raw path, this one is resolved as a package subpath and
 * matches the `export default` convention every sibling extension in this repo
 * already uses (`doom-task`, `doom-file-edit`, `doom-pi-ui`).
 */
export function installTeamRuntime(cordis: Context, pi: ExtensionAPI): TeamExtensionRuntime {
  let telemetry: DoomTelemetry | undefined;
  const getTelemetry = (ctx: ExtensionContext): DoomTelemetry => {
    telemetry ??= createDoomTelemetry({
      serviceName: 'doom-team',
      packageName: '@agimon-ai/doompi-team',
      cwd: ctx.cwd,
      env: process.env,
      enableLogs: true,
      enableTraces: true,
    });
    return telemetry;
  };
  const reportConcurrencyEvent = (event: string, attributes: Record<string, unknown>): void => {
    void telemetry?.recordEvent(event, attributes);
  };
  cordis.effect(
    () => async () => {
      await telemetry?.shutdown();
      telemetry = undefined;
    },
    '@agimon-ai/doompi-team/telemetry',
  );
  const runtime = createTeamExtensionRuntime(reportConcurrencyEvent);
  const {
    subagentTool,
    teamChannel,
    pollScheduler,
    asyncJobTracker,
    subagentWaiter,
    asyncSubagentSpawner,
    discovery,
    skills,
    spawnPlanner,
    completionNotifier,
    resultWatcher,
    staleRunReconciler,
    management,
    capabilityPolicies,
    mcpToolResolver,
  } = runtime;

  let active = true;
  let sessionGeneration = 0;
  let readinessAbort: AbortController | undefined;
  let readinessHandle: Promise<DoomReadinessHandle<void>> | undefined;
  let readinessSessionManager: object | undefined;
  let standaloneReadiness: DoomReadinessCoordinator | undefined;
  let readinessNotificationContext: ExtensionContext | undefined;
  let activeCordisSession:
    | {
        readonly cordis: Context;
        readonly service: DoomCordisSessionService;
      }
    | undefined;
  cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
    const service = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
    const binding = { cordis: sessionContext, service };
    activeCordisSession = binding;
    sessionContext.inject([DOOM_MCP_TOOL_RESOLVER_SERVICE], (resolverContext) =>
      mcpToolResolver.bind(requireDoomMcpToolResolver(resolverContext)),
    );
    sessionContext.inject([DOOM_CONTEXT_CONTRIBUTIONS_SERVICE], (contributionContext) => {
      const registration = requireDoomContextContributions(contributionContext).register({
        source: PACKAGE_SOURCE,
        id: 'runtime',
        label: 'Team',
        order: 200,
        snapshot: () => formatTeamContextSnapshot(readActiveTeamSnapshot()),
      });
      return () => registration.dispose();
    });
    sessionContext.effect(
      () => () => {
        if (activeCordisSession === binding) activeCordisSession = undefined;
      },
      `${PACKAGE_SOURCE}/cordis-session`,
    );
  });
  const coordinatorFor = (ctx: ExtensionContext): DoomReadinessCoordinator => {
    const cordisSession = activeCordisSession;
    const sessionId = ctx.sessionManager.getSessionId();
    const activeSessionMatches =
      cordisSession?.service.context.sessionManager === ctx.sessionManager &&
      cordisSession.service.sessionId === sessionId;
    const shared = activeSessionMatches ? readDoomReadinessCoordinator(cordisSession.cordis) : undefined;
    if (shared) return shared;
    standaloneReadiness ??= createDoomReadinessCoordinator({
      notify: (notification) => {
        const message = readinessNotificationMessage(notification);
        if (readinessNotificationContext?.hasUI) readinessNotificationContext.ui.notify(message, 'warning');
        else process.emitWarning(message);
      },
    });
    return standaloneReadiness;
  };
  const waitForSessionReadiness = async (ctx: ExtensionContext, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const pending = readinessHandle;
    if (!pending) throw new Error('Doom Team session initialization has not started.');
    if (readinessSessionManager !== ctx.sessionManager) {
      throw new Error('Doom Team readiness belongs to a stale Pi session.');
    }
    const handle = await pending;
    signal?.throwIfAborted();
    await handle.wait(signal ? { signal } : undefined);
    if (!active || pending !== readinessHandle || readinessSessionManager !== ctx.sessionManager) {
      throw new Error('Doom Team readiness belongs to a stale extension generation.');
    }
  };
  const readinessPi = new Proxy(pi, {
    get(target, property) {
      if (property === 'registerTool') {
        return (tool: RegisteredTool): void => {
          target.registerTool({
            ...tool,
            execute: async (toolCallId, params, signal, onUpdate, ctx) => {
              await waitForSessionReadiness(ctx, signal);
              return tool.execute(toolCallId, params, signal, onUpdate, ctx);
            },
          });
        };
      }
      if (property === 'registerCommand') {
        return (name: string, options: CommandOptions): void => {
          target.registerCommand(name, {
            ...options,
            handler: async (args, ctx) => {
              await waitForSessionReadiness(ctx);
              return options.handler(args, ctx);
            },
          });
        };
      }
      if (property === 'registerShortcut') {
        return (shortcut: Parameters<ExtensionAPI['registerShortcut']>[0], options: ShortcutOptions): void => {
          target.registerShortcut(shortcut, {
            ...options,
            handler: async (ctx) => {
              await waitForSessionReadiness(ctx);
              return options.handler(ctx);
            },
          });
        };
      }
      return boundPiValue(target, property);
    },
  });

  subagentTool.registerTool(readinessPi);

  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => registerSubagentLeaderContribution(requireDoomUiHub(uiContext)));

  const teamRuntime = teamChannel.createRuntime(readinessPi);
  cordis.effect(() => () => teamRuntime.dispose(), '@agimon-ai/doompi-team/channel');
  teamChannel.registerClient(readinessPi);

  // Attach before `ResultWatcher.start()`, which `session_start` drives.
  completionNotifier.attachHost(pi);
  cordis.effect(() => () => completionNotifier.dispose(), '@agimon-ai/doompi-team/completions');

  pollScheduler.start();
  cordis.effect(() => () => pollScheduler.stop(), '@agimon-ai/doompi-team/polling');

  asyncJobTracker.start();
  cordis.effect(() => () => asyncJobTracker.stop(), '@agimon-ai/doompi-team/jobs');

  let collaborationFiber: Fiber | undefined;
  let currentSessionJobs: TrackedAsyncJobsContract | undefined;
  // The scope `ResultWatcher` is currently watching. See its start site in
  // the `session_start` handler for why the watcher is latched on this
  // rather than started once.
  let watchedScopeKey: string | undefined;
  const delegationBridge = createDelegationBridge({
    planner: spawnPlanner,
    management,
    waiter: subagentWaiter,
    scheduler: pollScheduler,
    tracker: asyncJobTracker,
    loadConfig: () => loadConfig().config,
  });
  const fablePlanBridge = createFablePlanBridge({
    spawner: asyncSubagentSpawner,
    waiter: subagentWaiter,
    management,
    policies: capabilityPolicies,
    report: (event, attributes) => {
      void telemetry?.recordEvent(event, attributes);
    },
  });
  cordis.effect(
    () => async () => {
      await collaborationFiber?.dispose();
      collaborationFiber = undefined;
    },
    '@agimon-ai/doompi-team/collaboration',
  );
  cordis.effect(
    () => () => {
      resultWatcher.stop();
      watchedScopeKey = undefined;
    },
    '@agimon-ai/doompi-team/result-watcher',
  );

  const unregisterStaleRunReconciler = pollScheduler.register({
    id: 'stale-run-reconciler',
    // Crash detection, not status freshness - `AsyncJobTracker` owns that and
    // polls on its own 250ms. This subscriber only ever acts on a run whose
    // process is provably dead, so noticing that 2s later is invisible, while
    // running it 4x/second per active run was not: each pass is a status read,
    // a run-id resolve and a pid probe that a healthy child always discards.
    intervalMs: STALE_RUN_RECONCILE_INTERVAL_MS,
    run: async () => {
      let repaired = false;
      let hasActiveRun = false;
      for (const job of currentSessionJobs?.list() ?? []) {
        if (job.status && TERMINAL_ASYNC_JOB_STATES.has(job.status)) continue;
        hasActiveRun = true;
        // One pass, one `inspect()`. Calling `reconcile` and
        // `sweepOrphanedClaims` separately probed the same pid twice for the
        // same answer - see `StaleRunReconcilerContract.reconcileAndSweep`.
        const { reconcile: outcome, sweep } = staleRunReconciler.reconcileAndSweepAsync
          ? await staleRunReconciler.reconcileAndSweepAsync(job.runId)
          : staleRunReconciler.reconcileAndSweep(job.runId);
        if (outcome.repaired) {
          currentSessionJobs?.track(job.runId);
          repaired = true;
        }
        if (sweep.recovered.length > 0) repaired = true;
      }
      // An active runner is useful work for scheduling purposes: keeping
      // the shared scheduler at its floor prevents crash detection from
      // inheriting the idle five-second backoff ceiling.
      return repaired || hasActiveRun;
    },
  });
  cordis.effect(() => unregisterStaleRunReconciler, '@agimon-ai/doompi-team/stale-runs');
  // The orchestration addendum. Registered here rather than inside the
  // `subagent` tool's description because it is behavioural guidance, and it
  // has to land before the model decides whether to reach for the tool at
  // all - see `orchestratorPrompt.ts`. Read config per turn so toggling it
  // does not need a session restart; `loadConfig` is memoized on the file's
  // own mtime, so this is a stat, not a read.
  pi.on('before_agent_start', (event: { systemPrompt?: string }) => {
    if (!active || !shouldInjectOrchestratorPrompt(loadConfig().config)) return undefined;
    return { systemPrompt: appendOrchestratorPrompt(event.systemPrompt) };
  });

  const state: SlashCommandState = { baseCwd: undefined };

  /**
   * Publish what this session can launch, for the cockpit hub to read.
   *
   * The hub and the session API run in `doompi-server`, which never receives
   * the domain projection's agent directories or the harness state behind the
   * Team model policy, so discovery run there misses every domain-provided
   * agent. This process has both. Republished on each turn so an agent file
   * added mid-session shows up without a restart.
   */
  const publishCatalogSnapshot = (cwd: string, sessionId: string): void => {
    // A spawned child shares its parent's scope directory; only the root
    // session may write the catalog the user is looking at.
    if (resolveRootSessionId(sessionId) !== sessionId) return;
    try {
      writeSessionCatalogSnapshot(sessionId, {
        cwd,
        agents: presentCatalog(discovery.discover(cwd, 'both').agents),
        models: resolveActiveTeamModelSpecs() ?? [],
      });
    } catch {
      // Best effort: the hub falls back to its own discovery, and every launch
      // path reports discovery failures on its own.
    }
  };

  pi.on('before_agent_start', (_event: { systemPrompt?: string }, ctx: ExtensionContext) => {
    if (!active) return undefined;
    publishCatalogSnapshot(ctx.cwd, ctx.sessionManager.getSessionId());
    return undefined;
  });
  const slashCommandDeps = buildSlashCommandDeps(
    discovery,
    skills,
    spawnPlanner,
    asyncJobTracker,
    pollScheduler,
    management,
  );
  registerSlashCommands(readinessPi, state, slashCommandDeps);
  registerAgentListCommand(readinessPi, {
    discovery,
    skills,
    policies: capabilityPolicies,
    // The catalog's r/R keys spawn through the same path as `/run`, so a run
    // started from the overlay is tracked and reported like any other.
    launchAgent: (ctx, request) =>
      startSingleAgentRun(readinessPi, ctx, state, slashCommandDeps, {
        agent: request.agent,
        task: request.task,
        fork: request.context === 'fork',
      }),
  });
  registerFleetCommand(readinessPi, {
    scheduler: pollScheduler,
    tracker: asyncJobTracker,
    management,
  });
  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    return registerAgentStatus(pi, requireDoomUiHub(uiContext), {
      scheduler: pollScheduler,
      tracker: asyncJobTracker,
    });
  });
  registerCompletionRenderer(pi);
  registerSlashRunRenderer(pi);

  const retireSessionBindings = async (): Promise<Error | undefined> => {
    const errors: unknown[] = [];
    const previousCollaboration = collaborationFiber;
    collaborationFiber = undefined;
    try {
      await previousCollaboration?.dispose();
    } catch (error) {
      errors.push(error);
    }
    for (const cleanup of [
      () => capabilityPolicies.clear(),
      () => delegationBridge.abandonAll(),
      () => fablePlanBridge.abandonAll(),
      () => teamRuntime.dispose(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    currentSessionJobs = undefined;
    if (errors.length === 0) return undefined;
    if (errors.length === 1 && errors[0] instanceof Error) return errors[0];
    return new AggregateError(errors, 'Team session cleanup failed.');
  };

  // Bind the root session directly into the one intercom transport. Child
  // processes bind from the team environment written during spawn.
  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    if (!active) return undefined;
    const ownGeneration = ++sessionGeneration;
    const previousReadiness = readinessHandle;
    readinessAbort?.abort(new Error('Doom Team session initialization was superseded.'));
    const ownReadinessAbort = new AbortController();
    readinessAbort = ownReadinessAbort;
    readinessSessionManager = ctx.sessionManager;
    readinessNotificationContext = ctx;
    const activeTelemetry = getTelemetry(ctx);
    void activeTelemetry.recordEvent('doom_team.session_started', {
      'team.root_session':
        resolveRootSessionId(ctx.sessionManager.getSessionId()) === ctx.sessionManager.getSessionId(),
    });
    // Before anything else: every scoped path helper reads this. A child
    // keeps the root inherited from its spawn environment, while a top-level
    // session falls back to its own Pi session id.
    const sessionId = ctx.sessionManager.getSessionId();
    const scope = createSessionScope(resolveRootSessionId(sessionId));
    setCurrentSessionScope(scope);
    state.baseCwd = ctx.cwd;
    publishCatalogSnapshot(ctx.cwd, sessionId);
    if (watchedScopeKey !== undefined && watchedScopeKey !== scope.scopeKey) {
      resultWatcher.stop();
      watchedScopeKey = undefined;
    }
    const retirement = retireSessionBindings();
    const coordinator = coordinatorFor(ctx);
    const ownsSession = (): boolean =>
      active &&
      ownGeneration === sessionGeneration &&
      readinessSessionManager === ctx.sessionManager &&
      !ownReadinessAbort.signal.aborted;

    readinessHandle = (async (): Promise<DoomReadinessHandle<void>> => {
      if (previousReadiness) {
        await Promise.allSettled([previousReadiness.then((handle) => handle.wait())]);
      }
      if (!ownsSession()) throw new Error('Doom Team session initialization was superseded.');
      return coordinator.start(PACKAGE_SOURCE, `${sessionId}:${ownGeneration}`, async (signal) => {
        signal.throwIfAborted();
        const retirementError = await retirement;
        if (retirementError) throw retirementError;
        if (!ownsSession()) return { value: undefined };
        // Claim the scope for this process, so a later sweep can tell an
        // abandoned tree from a live one. Rewritten on every session_start
        // because /resume legitimately re-adopts a scope under a new process.
        await writeScopeOwnerAsync(scope);
        signal.throwIfAborted();
        if (!ownsSession()) return { value: undefined };
        // Prune records whose process is gone, reap sibling scopes holding
        // nothing alive, and REPORT what is suspended. Nothing is restarted:
        // reopening a session must not silently spend tokens on stale work.
        const opened = await openScopeAsync(scope, {
          readStatusAsync: async (runId) =>
            management.statusAsync ? (await management.statusAsync(runId)).status : management.status(runId).status,
        });
        signal.throwIfAborted();
        if (!ownsSession()) return { value: undefined };
        if (opened.suspended.length > 0 && ctx.hasUI) {
          const message = await formatSuspendedRunsAsync(opened.suspended);
          signal.throwIfAborted();
          if (!ownsSession()) return { value: undefined };
          ctx.ui.notify(message, 'info');
        }
        void activeTelemetry.recordEvent('doom_team.runs_restored', {
          'team.suspended_count': opened.suspended.length,
          'team.pruned_count': opened.pruned.length,
          'team.reaped_count': opened.reaped,
          outcome: 'reported',
        });
        currentSessionJobs = asyncJobTracker.forSession(sessionId);
        // ResultWatcher needs the session scope, but a repeated start for the
        // same scope must not reset its in-flight claims.
        if (watchedScopeKey !== scope.scopeKey) {
          watchedScopeKey = scope.scopeKey;
          resultWatcher.start(async (result) => {
            const jobs = currentSessionJobs;
            if (!jobs?.get(result.runId)) return false;
            const accepted = await completionNotifier.deliver(result);
            if (accepted) asyncJobTracker.acknowledgeHandoff(sessionId, result.runId);
            return accepted;
          });
        }
        const parentModel = normalizeParentModel(ctx.model);
        const activeSession = activeCordisSession;
        const collaborationParent =
          activeSession?.service.context.sessionManager === ctx.sessionManager ? activeSession.cordis : cordis;
        const nextCollaboration = collaborationParent.plugin(teamCollaborationPlugin, {
          session: {
            sessionId,
            cwd: ctx.cwd,
            availableModels: authenticatedModelInfos(ctx.modelRegistry),
            ...(parentModel ? { parentModel } : {}),
            captureForkSource: () => captureSessionForkSource(ctx.sessionManager, 'tool'),
          },
          directRunTracker: asyncJobTracker,
          delegation: delegationBridge,
          fablePlan: fablePlanBridge,
          policies: capabilityPolicies,
          observeDelegation: (observation) => recordDelegationObservation(activeTelemetry, observation),
        });
        collaborationFiber = nextCollaboration;
        await nextCollaboration.await();
        if (!ownsSession()) {
          await nextCollaboration.dispose();
          if (collaborationFiber === nextCollaboration) collaborationFiber = undefined;
          return { value: undefined };
        }
        teamRuntime.bindMainSession(sessionId);
        return { value: undefined };
      });
    })();
    // Config's coordinator owns the single user-facing failure notification.
    void Promise.allSettled([readinessHandle.then((handle) => handle.wait())]);
    return undefined;
  });

  cordis.effect(
    () => async () => {
      active = false;
      sessionGeneration += 1;
      const pendingReadiness = readinessHandle;
      readinessHandle = undefined;
      readinessSessionManager = undefined;
      readinessAbort?.abort(new Error('Doom Team runtime was disposed.'));
      readinessAbort = undefined;
      const ownedReadiness = standaloneReadiness;
      standaloneReadiness = undefined;
      if (ownedReadiness) await ownedReadiness.dispose();
      else if (pendingReadiness) await Promise.allSettled([pendingReadiness.then((handle) => handle.wait())]);
      readinessNotificationContext = undefined;
    },
    '@agimon-ai/doompi-team/session-fence',
  );

  /**
   * Every reason suspends, with no exception for `reload`.
   *
   * Pi emits this for `quit`, `reload`, `new`, `resume` and `fork`. Treating
   * `reload` differently - keeping children alive because `/domains`, `/major-mode`
   * and `/profile` only reload the extension - would be the one case someone
   * has to remember, and the one that silently misbehaves if Pi adds a sixth
   * reason. Suspending uniformly costs a respawn on reload; restore continues
   * the child's own transcript rather than restarting its task.
   */
  let shutdownPromise: Promise<void> | undefined;
  const shutdownSession = async (event: { reason?: string }): Promise<void> => {
    active = false;
    sessionGeneration += 1;
    const pendingReadiness = readinessHandle;
    readinessHandle = undefined;
    readinessSessionManager = undefined;
    readinessAbort?.abort(new Error('Doom Team session ended.'));
    readinessAbort = undefined;
    const ownedReadiness = standaloneReadiness;
    standaloneReadiness = undefined;
    await Promise.allSettled([
      ...(pendingReadiness ? [pendingReadiness.then((handle) => handle.wait())] : []),
      ...(ownedReadiness ? [ownedReadiness.dispose()] : []),
    ]);
    const scope = tryCurrentSessionScope();
    const suspensionPromise = scope
      ? suspendScopeRuns({
          scope,
          reason: event.reason ?? SESSION_SHUTDOWN_REASON_FALLBACK,
          readStatus: (runId) => management.status(runId).status,
        })
      : Promise.resolve(undefined);
    let suspension: Awaited<ReturnType<typeof suspendScopeRuns>> | undefined;
    try {
      suspension = await suspensionPromise;
      await telemetry?.recordEvent('doom_team.session_finished', {
        reason: event.reason ?? SESSION_SHUTDOWN_REASON_FALLBACK,
        'team.suspended_count': suspension?.suspended.length ?? 0,
        'team.unstoppable_count': suspension?.unstoppable.length ?? 0,
        outcome: suspension?.unstoppable.length ? 'degraded' : 'suspended',
      });
    } catch (error) {
      await telemetry?.recordError('doom_team.session_shutdown_failed', error, {
        reason: event.reason ?? SESSION_SHUTDOWN_REASON_FALLBACK,
      });
    } finally {
      await telemetry?.shutdown();
      telemetry = undefined;
    }
  };
  pi.on('session_shutdown', (event: { reason?: string }) => {
    shutdownPromise ??= shutdownSession(event);
    return shutdownPromise;
  });

  return runtime;
}
