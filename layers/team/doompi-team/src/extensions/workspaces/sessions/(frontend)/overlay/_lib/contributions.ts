/**
 * Wires the agent catalog, run fleet, and compact footer status into the host.
 *
 * DESIGN PATTERNS:
 * - Wiring only: display decisions live in `agent-catalog.cli.ts`, `fleet.cli.ts`, and
 *   `fleetStatus.ts`; this file connects those surfaces to host services.
 */

import { resolveRootSessionId } from '@agimon-ai/doompi-core/child-process';
import type { TranscriptPage, TranscriptPageRequest } from '@agimon-ai/doompi-core/session-protocol';
import type { DoomUiHubService } from '@agimon-ai/doompi-core/ui-hub';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  type AsyncJobTrackerContract,
  type TrackedAsyncJobsContract,
  resolveTrackedRunId,
} from '../../../../../../services/asyncJobTracker';
import type { ManagementActionsContract } from '../../../../../../services/managementActions';
import type { PollSchedulerContract } from '../../../../../../services/pollScheduler';
import { createSessionScope, type SessionScope } from '../../../../../../services/sessionPaths';
import type { FleetActionDispatcher } from './fleet.cli';
import { AGENT_PULSE_FRAMES, agentFleetStatus, COST_STATUS_KEY, FLEET_STATUS_KEY } from './fleetStatus';

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
/** Sub-cent precision: below any real run cost, short enough to read. */
const COST_DECIMALS = 6;

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

export interface RegisterFleetCommandDeps {
  scheduler: PollSchedulerContract;
  tracker: AsyncJobTrackerContract;
  /** Optional: absent until a composition root wires runtime controls to a real dispatcher. */
  dispatchAction?: FleetActionDispatcher;
  /** Builds context-scoped controls when a static test dispatcher is not supplied. */
  management?: ManagementActionsContract;
  readTranscriptPage?: (
    runId: string,
    request: Omit<TranscriptPageRequest, 'threadId'>,
    signal?: AbortSignal,
  ) => Promise<TranscriptPage>;
  environment: Readonly<Record<string, string | undefined>>;
}

export function createFleetActionDispatcher(
  management: ManagementActionsContract,
  jobs: TrackedAsyncJobsContract,
): FleetActionDispatcher {
  return async (request) => {
    const runId = resolveTrackedRunId(jobs, request.id);
    if (request.action === 'interrupt') {
      await management.interrupt(runId, request.message);
      return { status: REQUESTED_STATUS };
    }
    if (request.action === 'stop') {
      await management.stop(runId, request.message);
      return { status: REQUESTED_STATUS };
    }
    if (request.action === 'steer') {
      const result = await management.steer(runId, request.message ?? '');
      return { status: result.state, detail: result.message };
    }
    throw new Error('Resume is not supported by the current subagent runtime.');
  };
}

export function createAgentStatus(
  hub: DoomUiHubService,
  deps: RegisterFleetCommandDeps,
): { sessionStart(context: ExtensionContext): void; dispose(): void } {
  let current:
    | {
        ctx: ExtensionContext;
        scope: SessionScope;
        jobs: TrackedAsyncJobsContract;
        fingerprint: string | undefined;
        /**
         * Last-seen cost per run. The tracker evicts a finished run once its
         * retention window expires, so summing `list()` alone would make the
         * session total drop; remembering the run's final figure here keeps it
         * monotonic for as long as the session lives.
         */
        costs: Map<string, number>;
        costText: string | undefined;
      }
    | undefined;
  let disposed = false;
  let frame = 0;
  const footerContribution = hub.registerFooter({
    source: SUBAGENT_LEADER_SOURCE,
    id: 'agent-count',
    order: AGENT_FOOTER_ORDER,
  });

  const publishCost = (): boolean => {
    if (!current) return false;
    for (const job of current.jobs.list()) {
      if (job.cost !== undefined) current.costs.set(job.runId, job.cost);
    }
    let total = 0;
    for (const cost of current.costs.values()) total += cost;
    // Repeated float addition leaves artifacts ('0.30000000000000004'); the
    // consumer reads this with Number(), so round to sub-cent precision first.
    // A zero total is published as nothing at all, so a session that never ran
    // an agent contributes no chip.
    const text = total > 0 ? String(Number(total.toFixed(COST_DECIMALS))) : undefined;
    if (text === current.costText) return false;
    current.costText = text;
    if (current.ctx.hasUI) current.ctx.ui.setStatus(COST_STATUS_KEY, text);
    return true;
  };

  const publish = (force = false): boolean => {
    if (!current) return false;
    const costChanged = publishCost();
    const status = agentFleetStatus(current.jobs, frame);
    const fingerprint = status?.fingerprint;
    // The fleet fingerprint ignores cost, so cost is published above the guard.
    if (!force && fingerprint === current.fingerprint) return costChanged;
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

  const sessionStart = (ctx: ExtensionContext): void => {
    if (disposed) return;
    const scope = createSessionScope(resolveRootSessionId(ctx.sessionManager.getSessionId(), deps.environment));
    current = {
      ctx,
      scope,
      jobs: deps.tracker.forSession(ctx.sessionManager.getSessionId(), scope),
      fingerprint: undefined,
      costs: new Map(),
      costText: undefined,
    };
    publish(true);
  };

  return {
    sessionStart,
    dispose() {
      if (disposed) return;
      disposed = true;
      unregisterPoll();
      footerContribution.dispose();
      if (current?.ctx.hasUI) {
        current.ctx.ui.setStatus(FLEET_STATUS_KEY, undefined);
        current.ctx.ui.setStatus(COST_STATUS_KEY, undefined);
      }
      current = undefined;
    },
  };
}
