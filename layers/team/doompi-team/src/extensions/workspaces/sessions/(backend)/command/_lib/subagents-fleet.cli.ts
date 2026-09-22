import { resolveRootSessionId } from '@agimon-ai/doompi-core/childProcess';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import type { TranscriptPage, TranscriptPageRequest } from '@agimon-ai/doompi-core/sessionProtocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { SUBAGENT_FLEET_COMMAND } from '../../../../../../constants/team';
import {
  type AsyncJobTrackerContract,
  type TrackedAsyncJobsContract,
  resolveTrackedRunId,
} from '../../../../../../services/asyncJobTracker';
import type { ManagementActionsContract } from '../../../../../../services/managementActions';
import type { PollSchedulerContract } from '../../../../../../services/pollScheduler';
import { createSessionScope, type SessionScope } from '../../../../../../services/sessionPaths';
import type { TeamPiScope } from '../../_lib/root.cli';
import { readyCommand } from '.././_lib/ready';

export interface FleetActionRequest {
  action: 'interrupt' | 'stop' | 'resume' | 'steer';
  id: string;
  message?: string;
}

export interface FleetActionResult {
  status: string;
  detail?: string;
}

export type FleetActionDispatcher = (request: FleetActionRequest) => Promise<FleetActionResult>;

export interface RegisterFleetCommandDeps {
  scheduler: PollSchedulerContract;
  tracker: AsyncJobTrackerContract;
  dispatchAction?: FleetActionDispatcher;
  management?: ManagementActionsContract;
  readTranscriptPage?: (
    runId: string,
    request: Omit<TranscriptPageRequest, 'threadId'>,
    signal?: AbortSignal,
  ) => Promise<TranscriptPage>;
  environment: Readonly<Record<string, string | undefined>>;
}

export type OpenSubagentFleet = (
  context: ExtensionContext,
  scheduler: PollSchedulerContract,
  jobs: TrackedAsyncJobsContract,
  scope: SessionScope,
  options: {
    dispatchAction?: FleetActionDispatcher;
    readTranscriptPage?: RegisterFleetCommandDeps['readTranscriptPage'];
  },
) => Promise<void>;

export const createFleetContribution =
  (openSubagentFleet: OpenSubagentFleet) => (context: WithRoot<PiPluginContext, TeamPiScope>) => {
    const { pollScheduler, asyncJobTracker, management } = context.root.runtime;
    const [command] = createFleetCommand(
      {
        scheduler: pollScheduler,
        tracker: asyncJobTracker,
        management,
        readTranscriptPage: context.root.readTranscriptPage,
        environment: context.root.environment,
      },
      openSubagentFleet,
    );
    return readyCommand(context.root, command);
  };

export function createFleetActionDispatcher(
  management: ManagementActionsContract,
  jobs: TrackedAsyncJobsContract,
): FleetActionDispatcher {
  return async (request) => {
    const runId = resolveTrackedRunId(jobs, request.id);
    if (request.action === 'interrupt') {
      await management.interrupt(runId, request.message);
      return { status: 'requested' };
    }
    if (request.action === 'stop') {
      await management.stop(runId, request.message);
      return { status: 'requested' };
    }
    if (request.action === 'steer') {
      const result = await management.steer(runId, request.message ?? '');
      return { status: result.state, detail: result.message };
    }
    throw new Error('Resume is not supported by the current subagent runtime.');
  };
}

export function createFleetCommand(
  deps: RegisterFleetCommandDeps,
  openSubagentFleet: OpenSubagentFleet,
): Array<readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]]> {
  return [
    [
      SUBAGENT_FLEET_COMMAND,
      {
        description: 'Open the live agent runs overlay: inspect current-session runs and apply runtime controls',
        handler: async (_args: string, ctx: ExtensionContext) => {
          const scope = createSessionScope(resolveRootSessionId(ctx.sessionManager.getSessionId(), deps.environment));
          const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId(), scope);
          const dispatchAction =
            deps.dispatchAction ?? (deps.management ? createFleetActionDispatcher(deps.management, jobs) : undefined);
          await openSubagentFleet(ctx, deps.scheduler, jobs, scope, {
            dispatchAction,
            readTranscriptPage: deps.readTranscriptPage,
          });
        },
      },
    ],
  ];
}
