/**
 * Explicit composition for the parent Team extension process.
 *
 * The object graph is deliberately built in one place. Cordis owns the
 * adapter plugin that creates this graph; the graph itself contains ordinary
 * TypeScript objects with constructor-declared dependencies.
 */

import { SubagentCapabilityPolicyStore } from '../../schemas/team/capabilityCeiling';
import type { DoomChildSessionServiceProvider } from '@agimon-ai/doompi-core/child';
import { AgentDiscoveryService } from '../agentDiscovery';
import { SkillDiscoveryService } from '../agentSkills';
import { NativeTeamChannelService } from '../nativeTeamChannel';
import { AsyncSubagentSpawner } from '../asyncExecution';
import { AsyncJobTracker, TERMINAL_ASYNC_JOB_STATES } from '../asyncJobTracker';
import { NativeRunCoordinator } from '../nativeRunCoordinator';
import type { NativeRunProjectionSink } from '../nativeRunProjection';
import { CompletionNotifier } from '../notify';
import { SubagentWaiter } from '../subagentWait';
import { AdmissionGate } from '../admissionGate';
import { McpDirectToolResolverBinding } from '../mcpDirectToolAllowlist';
import type { ConcurrencyEventReporter } from '../runWithConcurrency';
import { ManagementActions } from '../managementActions';
import { SpawnPlanner } from '../spawnPlan';
import { SubagentToolService } from '../subagentTool';
import { PollScheduler } from '../pollScheduler';
import { ExternalProcessIpc, type ExternalProcessEvent } from '../externalProcessIpc';

const ignoreConcurrencyEvent: ConcurrencyEventReporter = () => undefined;

/** Services used by the parent Pi adapter, grouped as one lifecycle-owned graph. */
export interface TeamExtensionRuntime {
  readonly subagentTool: SubagentToolService;
  readonly teamChannel: NativeTeamChannelService;
  readonly pollScheduler: PollScheduler;
  readonly asyncJobTracker: AsyncJobTracker;
  readonly nativeRuns: NativeRunCoordinator;
  readonly subagentWaiter: SubagentWaiter;
  readonly asyncSubagentSpawner: AsyncSubagentSpawner;
  readonly discovery: AgentDiscoveryService;
  readonly skills: SkillDiscoveryService;
  readonly spawnPlanner: SpawnPlanner;
  readonly completionNotifier: CompletionNotifier;
  readonly externalProcesses: ExternalProcessIpc;
  readonly dispose: () => void;
  readonly management: ManagementActions;
  readonly capabilityPolicies: SubagentCapabilityPolicyStore;
  readonly mcpToolResolver: McpDirectToolResolverBinding;
  readonly reportConcurrencyEvent: ConcurrencyEventReporter;
}

/** Lazy dependencies supplied by the owning Pi or headless host. */
export interface TeamExtensionRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly childSessions?: DoomChildSessionServiceProvider;
  readonly nativeRunProjection?: NativeRunProjectionSink;
}

/** Build one fresh parent graph for one Team Cordis adapter fiber. */
export function createTeamExtensionRuntime(
  reportConcurrencyEvent: ConcurrencyEventReporter | undefined,
  options: TeamExtensionRuntimeOptions,
): TeamExtensionRuntime {
  const report = reportConcurrencyEvent ?? ignoreConcurrencyEvent;
  const pollScheduler = new PollScheduler();
  const asyncJobTracker = new AsyncJobTracker();
  const admission = new AdmissionGate({
    countLiveRuns: (scope) =>
      asyncJobTracker
        .forSession(scope.rootSessionId, scope)
        .list()
        .filter((job) => job.status === undefined || !TERMINAL_ASYNC_JOB_STATES.has(job.status)).length,
  });
  const subagentWaiter = new SubagentWaiter(asyncJobTracker);
  const externalProcesses = new ExternalProcessIpc();
  const asyncSubagentSpawner = new AsyncSubagentSpawner(externalProcesses);
  const discovery = new AgentDiscoveryService();
  const skills = new SkillDiscoveryService();
  const capabilityPolicies = new SubagentCapabilityPolicyStore();
  const mcpToolResolver = new McpDirectToolResolverBinding();
  const completionNotifier = new CompletionNotifier();
  const nativeRuns = new NativeRunCoordinator(
    options.childSessions,
    asyncJobTracker,
    completionNotifier,
    options.nativeRunProjection,
  );
  const teamChannel = new NativeTeamChannelService();
  const spawnPlanner = new SpawnPlanner(
    discovery,
    asyncSubagentSpawner,
    capabilityPolicies,
    skills,
    report,
    mcpToolResolver,
    admission,
    options.childSessions,
    nativeRuns,
    teamChannel,
  );
  const management = new ManagementActions(asyncJobTracker, nativeRuns, externalProcesses);
  const onExternalEvent = (event: ExternalProcessEvent): void => {
    const sessionId = event.scope.rootSessionId;
    if ('message' in event) {
      const { message } = event;
      if (message.kind === 'status') asyncJobTracker.upsertExternal(sessionId, event.scope, message.status);
      if (message.kind === 'error') {
        asyncJobTracker.markExternalFailed(sessionId, event.scope, message.runId, message.error);
        void completionNotifier
          .deliver({ runId: message.runId, agent: 'external', success: false, summary: message.error })
          .then((delivered) => {
            if (delivered) asyncJobTracker.acknowledgeHandoff(sessionId, message.runId);
          });
      }
      if (message.kind === 'result') {
        if (!asyncJobTracker.acceptExternalResult(sessionId, event.scope, message.runId, message.result)) return;
        void completionNotifier.deliver({ ...message.result, runId: message.runId }).then((delivered) => {
          if (delivered) asyncJobTracker.acknowledgeHandoff(sessionId, message.runId);
        });
      }
      return;
    }
    const jobs = asyncJobTracker.forSession(sessionId, event.scope);
    const job = jobs.get(event.runId);
    if (!job || (job.status && TERMINAL_ASYNC_JOB_STATES.has(job.status))) return;
    const error = `External runner process exited unexpectedly (${event.signal ?? `code ${event.code ?? 'unknown'}`}).`;
    asyncJobTracker.markExternalFailed(sessionId, event.scope, event.runId, error);
    void completionNotifier
      .deliver({ runId: event.runId, agent: job.agent ?? 'external', success: false, summary: error })
      .then((delivered) => {
        if (delivered) asyncJobTracker.acknowledgeHandoff(sessionId, event.runId);
      });
  };
  const unsubscribeExternal = externalProcesses.subscribe(onExternalEvent);
  const subagentTool = new SubagentToolService(
    spawnPlanner,
    management,
    asyncJobTracker,
    discovery,
    options.environment,
  );

  const dispose = (): void => {
    unsubscribeExternal();
    externalProcesses.close();
  };

  return Object.freeze({
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
    externalProcesses,
    dispose,
    management,
    capabilityPolicies,
    mcpToolResolver,
    reportConcurrencyEvent: report,
  });
}
