import { createSubagentTool } from '../tools/subagent';
import { createIntercomTool } from '../tools/intercom';
import { validateParams as validateSubagentParams } from '../services/subagentTool';
import { renderSubagentCall, renderSubagentResult } from '../tui/subagentToolRender';
import { definePiExtension, definePiTool } from '@agimon-ai/doompi-extension-contracts/pi-extension';
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
import { readDoomChildSessionService } from '@agimon-ai/doompi-extension-contracts/child-session';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  requireDoomContextContributions,
} from '@agimon-ai/doompi-extension-contracts/context-contributions';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  requireDoomCordisSession,
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
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  createSlashCommands,
  startSingleAgentRun,
  type SlashCommandDeps,
  type SlashCommandState,
} from '../controllers/slashCommands';
import { loadConfig } from '../services/config';
import { createDelegationBridge } from '../services/delegationBridge';
import { createFablePlanBridge } from '../services/fablePlanBridge';
import type { ManagementActionsContract } from '../services/managementActions';
import { appendOrchestratorPrompt, shouldInjectOrchestratorPrompt } from '../services/orchestratorPrompt';
import { captureSessionForkSource, type SpawnPlannerContract } from '../services/spawnPlan';
import type { SkillDiscoveryContract } from '../services/agentSkills';
import type { AgentDiscoveryContract } from '../types/agent';
import { formatTeamContextSnapshot, readActiveTeamSnapshot } from '../services/teamSnapshot';
import type { AsyncJobTrackerContract } from '../services/asyncJobTracker';
import { openScopeAsync, suspendScopeRuns } from '../services/sessionLifecycle';
import { formatSuspendedRunsAsync } from '../services/suspendedRuns';
import { normalizeParentModel } from '../services/modelFallback';
import { authenticatedModelInfos } from '../services/modelResolution';
import { createSessionScope, type SessionScope } from '../services/sessionPaths';
import type { PollSchedulerContract } from '../services/pollScheduler';
import { createCompletionRenderer } from '../tui/completionNotice';
import { createSlashRunRenderer } from '../tui/slashRunNotice';
import {
  createAgentListCommand,
  createAgentStatus,
  createFleetCommand,
  registerSubagentLeaderContribution,
} from '../tui/contributions';
import { createTeamCollaborationMount, type TeamDelegationObservation } from '../services/teamCollaboration';
import { createTeamExtensionRuntime } from '../services/teamRuntime';

const SESSION_SHUTDOWN_REASON_FALLBACK = 'unknown';
const PACKAGE_SOURCE = '@agimon-ai/doompi-team';

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

/**
 * The extension factory pi's loader calls, exported as the module default
 * (see the override this file carries in `vibe-lint.config.yaml`). This is an
 * ESM `.ts` module, so it CANNOT use the `export =` form that
 * `subagentPromptRuntimeEntry.cts` is required to use - that file is `.cts`
 * and is resolved by raw path, this one is resolved as a package subpath and
 * matches the `export default` convention every sibling extension in this repo
 * already uses (`doom-task`, `doom-file-edit`, `doom-pi-ui`).
 */
export const activateTeamExtension = definePiExtension(
  PACKAGE_SOURCE,
  ({ context: cordis, pi, signal: pluginSignal }) => {
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
      subagentTool,
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
      dispose: disposeRuntime,
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
    let agentStatus: ReturnType<typeof createAgentStatus> | undefined;

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

    // The orchestration addendum. Registered here rather than inside the
    // `subagent` tool's description because it is behavioural guidance, and it
    // has to land before the model decides whether to reach for the tool at
    // all - see `orchestratorPrompt.ts`. Read config per turn so toggling it
    // does not need a session restart; `loadConfig` is memoized on the file's
    // own mtime, so this is a stat, not a read.
    const beforeAgentStart = (event: { systemPrompt?: string }) => {
      if (!active || !shouldInjectOrchestratorPrompt(loadConfig().config)) return undefined;
      return { systemPrompt: appendOrchestratorPrompt(event.systemPrompt) };
    };

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
    const commands = [
      ...createSlashCommands(pi, state, slashCommandDeps),
      ...createAgentListCommand({
        discovery,
        skills,
        policies: capabilityPolicies,
        // The catalog's r/R keys spawn through the same path as `/run`, so a run
        // started from the overlay is tracked and reported like any other.
        launchAgent: (ctx, request) =>
          startSingleAgentRun(pi, ctx, state, slashCommandDeps, {
            agent: request.agent,
            task: request.task,
            fork: request.context === 'fork',
          }),
      }),
      ...createFleetCommand({
        scheduler: pollScheduler,
        tracker: asyncJobTracker,
        management,
        readTranscriptPage: (runId, request, signal) => {
          const service = readDoomChildSessionService(activeCordisSession?.cordis ?? cordis);
          if (!service?.readTranscriptPage)
            return Promise.reject(new Error('The Doom child-session transcript reader is unavailable.'));
          return service.readTranscriptPage(runId, request, signal);
        },
        environment,
      }),
    ];

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

    return {
      services: [
        collaboration.plugin,
        (cordis: Context) => {
          cordis.effect(
            () => async () => {
              await telemetry?.shutdown();
              telemetry = undefined;
            },
            '@agimon-ai/doompi-team/telemetry',
          );
          cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
            const service = requireDoomCordisSession(sessionContext);
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
                snapshot: () => formatTeamContextSnapshot(readActiveTeamSnapshot(teamRuntime)),
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
          cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) =>
            registerSubagentLeaderContribution(requireDoomUiHub(uiContext)),
          );
          cordis.effect(
            () => () => {
              completionNotifier.dispose();
              disposeRuntime();
            },
            '@agimon-ai/doompi-team/completions',
          );
          cordis.effect(() => () => pollScheduler.stop(), '@agimon-ai/doompi-team/polling');
          cordis.effect(() => () => asyncJobTracker.stop(), '@agimon-ai/doompi-team/jobs');
          cordis.effect(() => () => nativeRuns.close(), '@agimon-ai/doompi-team/native-runs');
          cordis.effect(
            () => async () => {
              await collaborationFiber?.dispose();
              collaborationFiber = undefined;
            },
            '@agimon-ai/doompi-team/collaboration',
          );
          cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
            const status = createAgentStatus(requireDoomUiHub(uiContext), {
              scheduler: pollScheduler,
              tracker: asyncJobTracker,
              environment,
            });
            agentStatus = status;
            return () => {
              if (agentStatus === status) agentStatus = undefined;
              status.dispose();
            };
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
        },
      ],
      tools: [
        definePiTool(
          createSubagentTool(
            subagentTool,
            pi,
            {
              renderCall: (params, theme) => renderSubagentCall(validateSubagentParams(params), theme),
              renderResult: renderSubagentResult,
            },
            waitForSessionReadiness,
          ),
        ),
        definePiTool(createIntercomTool(teamRuntime, pi, waitForSessionReadiness)),
      ],
      commands: commands.map(
        ([name, options]) =>
          [
            name,
            {
              ...options,
              async handler(args, context) {
                await waitForSessionReadiness(context);
                return options.handler(args, context);
              },
            },
          ] as const,
      ),
      messageRenderers: [createCompletionRenderer(), createSlashRunRenderer()],
      onStart() {
        completionNotifier.attachHost(pi);
        pollScheduler.start();
      },
      events: {
        before_agent_start: beforeAgentStart,
        session_start(event, context) {
          agentStatus?.sessionStart(context);
          return sessionStart(event, context);
        },
        session_shutdown: sessionShutdown,
      },
    };
  },
);
export default activateTeamExtension;
