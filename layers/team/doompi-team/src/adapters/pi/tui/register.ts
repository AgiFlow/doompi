/**
 * Wires the agent catalog, run fleet, and compact footer status into the host.
 *
 * DESIGN PATTERNS:
 * - Wiring only: display decisions live in `agentCatalog.ts`, `fleet.ts`, and
 *   `fleetStatus.ts`; this file connects those surfaces to host services.
 */

import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ManagementActionsContract } from '../extensions/managementActions';
import type { SubagentCapabilityPolicyStore } from '../../../schemas/team/capabilityCeiling';
import { resolveActiveTeamPackageConfig } from '../../agents/discovery';
import type { SkillDiscoveryContract } from '../../agents/skills';
import type { AgentDiscoveryContract } from '../../agents/types';
import {
  type AsyncJobTrackerContract,
  type TrackedAsyncJobsContract,
  resolveTrackedRunId,
} from '../../asyncJobTracker';
import type { PollSchedulerContract } from '../../pollScheduler';
import { type AgentLaunchRequest, openAgentCatalog } from './agentCatalog';
import { buildAgentCatalogEntries } from './agentResourceProjection';
import { type FleetActionDispatcher, openSubagentFleet } from './fleet';
import { AGENT_PULSE_FRAMES, agentFleetStatus, FLEET_STATUS_KEY } from './fleetStatus';

export const SUBAGENT_FLEET_COMMAND = 'subagents-fleet';
export const SUBAGENT_LIST_COMMAND = 'subagents-list';
export const SUBAGENT_LEADER_SOURCE = '@agimon-ai/doompi-team';
const SUBAGENT_LEADER_ORDER = 15;
const SUBAGENT_LEADER_SEGMENT = {
  key: 'a',
  label: 'agents',
  detail: 'subagent resources and runs',
  order: SUBAGENT_LEADER_ORDER,
} as const;
const AGENT_FOOTER_ORDER = 20;
const AGENT_STATUS_POLL_INTERVAL_MS = 250;
const REQUESTED_STATUS = 'requested';

/** Publishes the nested SPC a menu for available agents and current-session runs. */
export function registerSubagentLeaderContribution(hub: DoomUiHubService): () => void {
  const contribution = hub.registerLeader({
    source: SUBAGENT_LEADER_SOURCE,
    bindings: [
      {
        id: 'subagents.fleet',
        path: [SUBAGENT_LEADER_SEGMENT, { key: 'r', label: 'runs', detail: 'runs in this session' }],
        command: { name: SUBAGENT_FLEET_COMMAND },
      },
      {
        id: 'subagents.list',
        path: [SUBAGENT_LEADER_SEGMENT, { key: 'l', label: 'list', detail: 'agents available here' }],
        command: { name: SUBAGENT_LIST_COMMAND },
      },
    ],
  });
  return () => contribution.dispose();
}

export interface RegisterAgentListCommandDeps {
  discovery: AgentDiscoveryContract;
  skills: SkillDiscoveryContract;
  policies: SubagentCapabilityPolicyStore;
  /** Optional: absent until a composition root wires the catalog's launch keys to a real spawn path. */
  launchAgent?: (ctx: ExtensionContext, request: AgentLaunchRequest) => void;
}

export function registerAgentListCommand(pi: ExtensionAPI, deps: RegisterAgentListCommandDeps): void {
  pi.registerCommand(SUBAGENT_LIST_COMMAND, {
    description: 'Browse agents available from this session cwd and inspect their projected launch resources',
    handler: async (_args: string, ctx: ExtensionContext) => {
      const agents = deps.discovery.discover(ctx.cwd, 'both').agents;
      const teamPackage = resolveActiveTeamPackageConfig();
      const availableSkills = deps.skills.discoverAvailableSkills(ctx.cwd);
      const skillSnapshot = {
        resolveSkillsWithFallback: (
          ...args: Parameters<SkillDiscoveryContract['resolveSkillsWithFallback']>
        ): ReturnType<SkillDiscoveryContract['resolveSkillsWithFallback']> =>
          deps.skills.resolveSkillsWithFallback(...args),
        discoverAvailableSkills: (): ReturnType<SkillDiscoveryContract['discoverAvailableSkills']> => availableSkills,
      };
      const entries = buildAgentCatalogEntries(agents, {
        cwd: ctx.cwd,
        skills: skillSnapshot,
        capabilityCeiling: deps.policies.resolve(),
        ...(teamPackage?.config.excludeTools
          ? { excludeTools: teamPackage.config.excludeTools, exclusionSource: teamPackage.path }
          : {}),
        environment: { ...process.env },
      });
      const launchAgent = deps.launchAgent;
      await openAgentCatalog(
        ctx,
        entries,
        launchAgent ? { launchAgent: (request: AgentLaunchRequest) => launchAgent(ctx, request) } : {},
      );
    },
  });
}

export interface RegisterFleetCommandDeps {
  scheduler: PollSchedulerContract;
  tracker: AsyncJobTrackerContract;
  /** Optional: absent until a composition root wires runtime controls to a real dispatcher. */
  dispatchAction?: FleetActionDispatcher;
  /** Builds context-scoped controls when a static test dispatcher is not supplied. */
  management?: ManagementActionsContract;
}

export function createFleetActionDispatcher(
  management: ManagementActionsContract,
  jobs: TrackedAsyncJobsContract,
): FleetActionDispatcher {
  return async (request) => {
    const runId = resolveTrackedRunId(jobs, request.id);
    if (request.action === 'interrupt') {
      management.interrupt(runId, request.message);
      return { status: REQUESTED_STATUS };
    }
    if (request.action === 'stop') {
      management.stop(runId, request.message);
      return { status: REQUESTED_STATUS };
    }
    if (request.action === 'steer') {
      const result = await management.steer(runId, request.message ?? '');
      return { status: result.state, detail: result.message };
    }
    throw new Error('Resume is not supported by the current subagent runtime.');
  };
}

export function registerAgentStatus(
  pi: ExtensionAPI,
  hub: DoomUiHubService,
  deps: RegisterFleetCommandDeps,
): () => void {
  let current: { ctx: ExtensionContext; jobs: TrackedAsyncJobsContract; fingerprint: string | undefined } | undefined;
  let disposed = false;
  let frame = 0;
  const footerContribution = hub.registerFooter({
    source: SUBAGENT_LEADER_SOURCE,
    id: 'agent-count',
    order: AGENT_FOOTER_ORDER,
  });

  const publish = (force = false): boolean => {
    if (!current) return false;
    const status = agentFleetStatus(current.jobs, frame);
    const fingerprint = status?.fingerprint;
    if (!force && fingerprint === current.fingerprint) return false;
    footerContribution.update(status?.footer);
    if (current.ctx.hasUI) current.ctx.ui.setStatus(FLEET_STATUS_KEY, status?.text);
    current.fingerprint = fingerprint;
    return true;
  };

  const unregisterPoll = deps.scheduler.register({
    id: 'doom-team-agent-status',
    intervalMs: AGENT_STATUS_POLL_INTERVAL_MS,
    run: () => {
      frame = (frame + 1) % AGENT_PULSE_FRAMES.length;
      return publish();
    },
  });

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    if (disposed) return;
    current = {
      ctx,
      jobs: deps.tracker.forSession(ctx.sessionManager.getSessionId()),
      fingerprint: undefined,
    };
    publish(true);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unregisterPoll();
    footerContribution.dispose();
    if (current?.ctx.hasUI) current.ctx.ui.setStatus(FLEET_STATUS_KEY, undefined);
    current = undefined;
  };
}

export function registerFleetCommand(pi: ExtensionAPI, deps: RegisterFleetCommandDeps): void {
  pi.registerCommand(SUBAGENT_FLEET_COMMAND, {
    description: 'Open the live agent runs overlay: inspect current-session runs and apply runtime controls',
    handler: async (_args: string, ctx: ExtensionContext) => {
      const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId());
      const dispatchAction =
        deps.dispatchAction ?? (deps.management ? createFleetActionDispatcher(deps.management, jobs) : undefined);
      await openSubagentFleet(ctx, deps.scheduler, jobs, { dispatchAction });
    },
  });
}
