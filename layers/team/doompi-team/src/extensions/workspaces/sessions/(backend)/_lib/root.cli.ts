import { readDoomBackgroundWorkService } from '@agimon-ai/doompi-core/backgroundWork';
import { resolveRootSessionId } from '@agimon-ai/doompi-core/childProcess';
import { readDoomChildSessionService } from '@agimon-ai/doompi-core/childSession';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  requireDoomContextContributions,
} from '@agimon-ai/doompi-core/contextContributions';
import type { DoomCordisSessionService } from '@agimon-ai/doompi-core/cordisHost';
import { DOOM_CORDIS_SESSION_SERVICE, requireDoomCordisSession } from '@agimon-ai/doompi-core/cordisHost';
import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import { DOOM_MCP_TOOL_RESOLVER_SERVICE, requireDoomMcpToolResolver } from '@agimon-ai/doompi-core/mcpToolResolver';
/**
 * Install the Team feature into one package-local Cordis root.
 *
 * The standard Pi factory owns that root and disposes it when Pi emits
 * `session_shutdown`. Each factory invocation therefore creates fresh session
 * state; no process-global container or replacement-root handshake participates
 * in reload. Long-lived services are registered as Cordis effects, and stale
 * asynchronous session-start continuations are fenced by a generation token.
 */
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import {
  createDoomReadinessCoordinator,
  type DoomReadinessCoordinator,
  type DoomReadinessHandle,
  type DoomReadinessNotification,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-core/readiness';
import type { TranscriptPage, TranscriptPageRequest } from '@agimon-ai/doompi-core/sessionProtocol';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService, requireDoomUiHub } from '@agimon-ai/doompi-core/uiHub';
import { provideBackgroundWorkService } from '@agimon-ai/doompi-session';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { SkillDiscoveryContract } from '../../../../../services/agentSkills';
import type { AsyncJobTrackerContract } from '../../../../../services/asyncJobTracker';
import { loadConfig } from '../../../../../services/config';
import { createDelegationBridge } from '../../../../../services/delegationBridge';
import { createFablePlanBridge } from '../../../../../services/fablePlanBridge';
import type { ManagementActionsContract } from '../../../../../services/managementActions';
import { normalizeParentModel } from '../../../../../services/modelFallback';
import { authenticatedModelInfos } from '../../../../../services/modelResolution';
import type { PollSchedulerContract } from '../../../../../services/pollScheduler';
import { openScopeAsync, suspendScopeRuns } from '../../../../../services/sessionLifecycle';
import { createSessionScope, type SessionScope } from '../../../../../services/sessionPaths';
import { captureSessionForkSource, type SpawnPlannerContract } from '../../../../../services/spawnPlan';
import { formatSuspendedRunsAsync } from '../../../../../services/suspendedRuns';
import {
  createTeamCollaborationMount,
  type TeamDelegationObservation,
} from '../../../../../services/teamCollaboration';
import { createTeamExtensionRuntime } from '../../../../../services/teamRuntime';
import { formatTeamContextSnapshot, readActiveTeamSnapshot } from '../../../../../services/teamSnapshot';
import type { AgentDiscoveryContract } from '../../../../../types/agent';
import type { SlashCommandDeps, SlashCommandState } from '.././command/_lib/launch';

const SESSION_SHUTDOWN_REASON_FALLBACK = 'unknown';
const PACKAGE_SOURCE = '@agimon-ai/doompi-team';

export interface AgentStatus {
  sessionStart(context: ExtensionContext): void;
  dispose(): void;
}

export interface TeamRootPresentation {
  createAgentStatus(
    hub: DoomUiHubService,
    deps: {
      scheduler: PollSchedulerContract;
      tracker: AsyncJobTrackerContract;
      environment: Readonly<Record<string, string | undefined>>;
    },
  ): AgentStatus;
  registerSubagentLeaderContribution(hub: DoomUiHubService): () => void;
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
  environment: Readonly<Record<string, string | undefined>>,
): SlashCommandDeps {
  return {
    spawnPlanner: planner,
    tracker,
    scheduler,
    discovery,
    skills,
    management,
    loadConfig: () => loadConfig().config,
    environment,
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

/** Constructs the shared object graph once for the CLI scope root. */
const createTeamRootExtension =
  (presentation: TeamRootPresentation) =>
  ({ context: cordis, pi, signal: pluginSignal }: PiPluginContext) => {
    let telemetry: DoomTelemetry | undefined;
    const environment = { ...process.env };
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

    const runtime = createTeamExtensionRuntime(reportConcurrencyEvent, {
      environment,
      childSessions: { get: () => readDoomChildSessionService(activeCordisSession?.cordis ?? cordis) },
    });
    const {
      teamChannel,
      pollScheduler,
      asyncJobTracker,
      nativeRuns,
      subagentWaiter,
      asyncSubagentSpawner,
      discovery,
      skills,
      spawnPlanner,
      completionNotifier,
      management,
      capabilityPolicies,
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
      if (
        !active ||
        pluginSignal.aborted ||
        pending !== readinessHandle ||
        readinessSessionManager !== ctx.sessionManager
      ) {
        throw new Error('Doom Team readiness belongs to a stale extension generation.');
      }
    };
    const teamRuntime = teamChannel.createRuntime(pi);
    let agentStatus: AgentStatus | undefined;

    const collaboration = createTeamCollaborationMount();
    let collaborationFiber: Fiber | undefined;
    let activeScope: SessionScope | undefined;
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

    const state: SlashCommandState = { baseCwd: undefined };

    const slashCommandDeps = buildSlashCommandDeps(
      discovery,
      skills,
      spawnPlanner,
      asyncJobTracker,
      pollScheduler,
      management,
      environment,
    );
    const readTranscriptPage = (
      runId: string,
      request: Omit<TranscriptPageRequest, 'threadId'>,
      signal?: AbortSignal,
    ): Promise<TranscriptPage> => {
      const service = readDoomChildSessionService(activeCordisSession?.cordis ?? cordis);
      if (!service?.readTranscriptPage)
        return Promise.reject(new Error('The Doom child-session transcript reader is unavailable.'));
      return service.readTranscriptPage(runId, request, signal);
    };

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
      ]) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 0) return undefined;
      if (errors.length === 1 && errors[0] instanceof Error) return errors[0];
      return new AggregateError(errors, 'Team session cleanup failed.');
    };

    // Bind the root session directly into the one intercom transport. Child
    // processes bind from the team environment written during spawn.
    const sessionStart = (_event: unknown, ctx: ExtensionContext) => {
      if (!active) return undefined;
      state.baseCwd = ctx.cwd;
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
          resolveRootSessionId(ctx.sessionManager.getSessionId(), environment) === ctx.sessionManager.getSessionId(),
      });
      const sessionId = ctx.sessionManager.getSessionId();
      const scope = createSessionScope(resolveRootSessionId(sessionId, environment));
      const previousScope = activeScope;
      if (previousScope) management.releaseSessionScope(previousScope);
      activeScope = scope;
      management.bindSessionScope(scope);
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
          // Suspended records are reported as durable history only. They never
          // seed the current session's live run tracker.
          const opened = await openScopeAsync(scope);
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
          const parentModel = normalizeParentModel(ctx.model);
          const nextCollaboration = await collaboration.mount(
            {
              session: {
                sessionId,
                sessionScope: scope,
                cwd: ctx.cwd,
                environment,
                availableModels: authenticatedModelInfos(ctx.modelRegistry),
                ...(parentModel ? { parentModel } : {}),
                captureForkSource: () => captureSessionForkSource(ctx.sessionManager, 'tool'),
              },
              directRunTracker: asyncJobTracker,
              delegation: delegationBridge,
              fablePlan: fablePlanBridge,
              policies: capabilityPolicies,
              observeDelegation: (observation) => recordDelegationObservation(activeTelemetry, observation),
            },
            ctx.sessionManager,
          );
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
    };

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
      state.baseCwd = undefined;
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
      const scope = activeScope;
      const suspensionPromise = scope
        ? suspendScopeRuns({
            scope,
            reason: event.reason ?? SESSION_SHUTDOWN_REASON_FALLBACK,
            jobs: asyncJobTracker.forSession(scope.rootSessionId, scope).list(),
            stop: (runId, reason) => management.stop(runId, reason),
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
        try {
          await nativeRuns.close();
        } catch (error) {
          await telemetry?.recordError('doom_team.native_shutdown_failed', error, {
            reason: event.reason ?? SESSION_SHUTDOWN_REASON_FALLBACK,
          });
        }
        if (activeScope) management.releaseSessionScope(activeScope);
        activeScope = undefined;
        teamRuntime.dispose();
        await telemetry?.shutdown();
        telemetry = undefined;
      }
    };
    const sessionShutdown = (event: { reason?: string }) => {
      shutdownPromise ??= shutdownSession(event);
      return shutdownPromise;
    };

    const bindCordisSession = (sessionContext: Context, service: DoomCordisSessionService) => {
      const binding = { cordis: sessionContext, service };
      activeCordisSession = binding;
      return () => {
        if (activeCordisSession === binding) activeCordisSession = undefined;
      };
    };
    const setAgentStatus = (status: AgentStatus) => {
      agentStatus = status;
      return () => {
        if (agentStatus === status) agentStatus = undefined;
        status.dispose();
      };
    };
    const shutdownTelemetry = async () => {
      await telemetry?.shutdown();
      telemetry = undefined;
    };
    const disposeCollaborationFiber = async () => {
      await collaborationFiber?.dispose();
      collaborationFiber = undefined;
    };
    const disposeReadinessFence = async () => {
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
    };

    const runtimeService = (serviceCordis: Context) => {
      serviceCordis.effect(() => shutdownTelemetry, `${PACKAGE_SOURCE}/telemetry`);
      serviceCordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
        const service = requireDoomCordisSession(sessionContext);
        const clearBinding = bindCordisSession(sessionContext, service);
        sessionContext.inject([DOOM_MCP_TOOL_RESOLVER_SERVICE], (resolverContext) =>
          runtime.mcpToolResolver.bind(requireDoomMcpToolResolver(resolverContext)),
        );
        sessionContext.inject([DOOM_CONTEXT_CONTRIBUTIONS_SERVICE], (contributionContext) => {
          const registration = requireDoomContextContributions(contributionContext).register({
            source: PACKAGE_SOURCE,
            id: 'runtime',
            label: 'Team',
            order: 200,
            snapshot: () => formatTeamContextSnapshot(readActiveTeamSnapshot(teamRuntime)),
          });
          return () => registration.dispose();
        });
        sessionContext.effect(() => clearBinding, `${PACKAGE_SOURCE}/cordis-session`);
      });
      serviceCordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) =>
        presentation.registerSubagentLeaderContribution(requireDoomUiHub(uiContext)),
      );
      serviceCordis.effect(
        () => () => {
          completionNotifier.dispose();
          runtime.dispose();
        },
        `${PACKAGE_SOURCE}/completions`,
      );
      serviceCordis.effect(() => () => pollScheduler.stop(), `${PACKAGE_SOURCE}/polling`);
      serviceCordis.effect(() => () => asyncJobTracker.stop(), `${PACKAGE_SOURCE}/jobs`);
      serviceCordis.effect(() => () => nativeRuns.close(), `${PACKAGE_SOURCE}/native-runs`);
      serviceCordis.effect(() => disposeCollaborationFiber, `${PACKAGE_SOURCE}/collaboration`);
      serviceCordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) =>
        setAgentStatus(
          presentation.createAgentStatus(requireDoomUiHub(uiContext), {
            scheduler: pollScheduler,
            tracker: asyncJobTracker,
            environment,
          }),
        ),
      );
      serviceCordis.effect(() => disposeReadinessFence, `${PACKAGE_SOURCE}/session-fence`);
    };

    return {
      value: {
        runtime,
        teamRuntime,
        collaboration,
        bindCordisSession,
        setAgentStatus,
        shutdownTelemetry,
        disposeCollaborationFiber,
        disposeReadinessFence,
        state,
        slashCommandDeps,
        environment,
        readTranscriptPage,
        contextSnapshot: () => formatTeamContextSnapshot(readActiveTeamSnapshot(teamRuntime)),
        waitForSessionReadiness,
        isActive: () => active,
        sessionStart(event: Parameters<typeof sessionStart>[0], context: Parameters<typeof sessionStart>[1]) {
          agentStatus?.sessionStart(context);
          return sessionStart(event, context);
        },
        sessionShutdown,
      },
      services: [
        (context: Context) => {
          if (readDoomBackgroundWorkService(context) === undefined) provideBackgroundWorkService(context);
        },
        collaboration.plugin,
        runtimeService,
      ],
      onStart() {
        completionNotifier.attachHost(pi);
        pollScheduler.start();
      },
    };
  };

export const createTeamRoot = (presentation: TeamRootPresentation) => defineRoot(createTeamRootExtension(presentation));
export type TeamPiScope = Awaited<ReturnType<ReturnType<typeof createTeamRoot>>>['value'];
