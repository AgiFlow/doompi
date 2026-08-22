/**
 * Explicit composition for the parent Team extension process.
 *
 * The object graph is deliberately built in one place. Cordis owns the
 * adapter plugin that creates this graph; the graph itself contains ordinary
 * TypeScript objects with constructor-declared dependencies.
 */

import { SubagentCapabilityPolicyStore } from '../../schemas/team/capabilityCeiling';
import { AgentDiscoveryService } from '../agents/discovery';
import { SkillDiscoveryService } from '../agents/skills';
import { NativeTeamChannelService } from '../intercom/nativeTeamChannel';
import { ControlChannelWatcher } from '../intercom/supervisorControlChannel';
import { AsyncSubagentSpawner } from '../runs/background/asyncExecution';
import { AsyncJobTracker } from '../asyncJobTracker';
import { CompletionNotifier } from '../runs/background/notify';
import { ProcessTerminalInspector } from '../processTerminal';
import { ResultWatcher } from '../resultWatcher';
import { RunIdResolver } from '../runIdResolver';
import { StaleRunReconciler } from '../staleRunReconciler';
import { CoalescedStatusWriter } from '../runs/background/statusWriter';
import { SubagentWaiter } from '../runs/background/subagentWait';
import { TerminalPersistenceService } from '../runs/background/terminalPersistence';
import { McpDirectToolResolverBinding } from '../runs/shared/mcpDirectToolAllowlist';
import type { ConcurrencyEventReporter } from '../runs/shared/runWithConcurrency';
import { ManagementActions } from './extensions/managementActions';
import { SpawnPlanner } from './extensions/spawnPlan';
import { SubagentToolService } from './extensions/subagentTool';
import { PollScheduler } from '../pollScheduler';

const ignoreConcurrencyEvent: ConcurrencyEventReporter = () => undefined;

/** Services used by the parent Pi adapter, grouped as one lifecycle-owned graph. */
export interface TeamExtensionRuntime {
  readonly subagentTool: SubagentToolService;
  readonly teamChannel: NativeTeamChannelService;
  readonly pollScheduler: PollScheduler;
  readonly statusWriter: CoalescedStatusWriter;
  readonly terminalPersistence: TerminalPersistenceService;
  readonly controlChannel: ControlChannelWatcher;
  readonly asyncJobTracker: AsyncJobTracker;
  readonly subagentWaiter: SubagentWaiter;
  readonly asyncSubagentSpawner: AsyncSubagentSpawner;
  readonly discovery: AgentDiscoveryService;
  readonly skills: SkillDiscoveryService;
  readonly spawnPlanner: SpawnPlanner;
  readonly completionNotifier: CompletionNotifier;
  readonly resultWatcher: ResultWatcher;
  readonly runIdResolver: RunIdResolver;
  readonly processTerminal: ProcessTerminalInspector;
  readonly staleRunReconciler: StaleRunReconciler;
  readonly management: ManagementActions;
  readonly capabilityPolicies: SubagentCapabilityPolicyStore;
  readonly mcpToolResolver: McpDirectToolResolverBinding;
  readonly reportConcurrencyEvent: ConcurrencyEventReporter;
}

/** Build one fresh parent graph for one Team Cordis adapter fiber. */
export function createTeamExtensionRuntime(
  reportConcurrencyEvent: ConcurrencyEventReporter = ignoreConcurrencyEvent,
): TeamExtensionRuntime {
  const pollScheduler = new PollScheduler();
  const statusWriter = new CoalescedStatusWriter();
  const terminalPersistence = new TerminalPersistenceService(statusWriter);
  const controlChannel = new ControlChannelWatcher(pollScheduler);
  const asyncJobTracker = new AsyncJobTracker(pollScheduler);
  const subagentWaiter = new SubagentWaiter(asyncJobTracker);
  const asyncSubagentSpawner = new AsyncSubagentSpawner(asyncJobTracker, terminalPersistence);
  const discovery = new AgentDiscoveryService();
  const skills = new SkillDiscoveryService();
  const capabilityPolicies = new SubagentCapabilityPolicyStore();
  const mcpToolResolver = new McpDirectToolResolverBinding();
  const spawnPlanner = new SpawnPlanner(
    discovery,
    asyncSubagentSpawner,
    capabilityPolicies,
    skills,
    reportConcurrencyEvent,
    mcpToolResolver,
  );
  const runIdResolver = new RunIdResolver();
  const processTerminal = new ProcessTerminalInspector();
  const management = new ManagementActions(runIdResolver, asyncJobTracker);
  const completionNotifier = new CompletionNotifier();
  const resultWatcher = new ResultWatcher(pollScheduler);
  const staleRunReconciler = new StaleRunReconciler(processTerminal, runIdResolver);
  const teamChannel = new NativeTeamChannelService();
  const subagentTool = new SubagentToolService(spawnPlanner, management, asyncJobTracker, discovery);

  return Object.freeze({
    subagentTool,
    teamChannel,
    pollScheduler,
    statusWriter,
    terminalPersistence,
    controlChannel,
    asyncJobTracker,
    subagentWaiter,
    asyncSubagentSpawner,
    discovery,
    skills,
    spawnPlanner,
    completionNotifier,
    resultWatcher,
    runIdResolver,
    processTerminal,
    staleRunReconciler,
    management,
    capabilityPolicies,
    mcpToolResolver,
    reportConcurrencyEvent,
  });
}
