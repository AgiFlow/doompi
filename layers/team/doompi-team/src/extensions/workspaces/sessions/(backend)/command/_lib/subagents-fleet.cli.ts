import { resolveRootSessionId } from '@agimon-ai/doompi-core/child-process';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  createFleetActionDispatcher,
  SUBAGENT_FLEET_COMMAND,
  type RegisterFleetCommandDeps,
} from '../../../(frontend)/overlay/_lib/contributions';
import { openSubagentFleet } from '../../../(frontend)/overlay/_lib/fleet.cli';
import { createSessionScope } from '../../../../../../services/sessionPaths';
import type { TeamPiScope } from '../../_lib/root.cli';
import { readyCommand } from '.././_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) => {
  const { pollScheduler, asyncJobTracker, management } = context.root.runtime;
  const [command] = createFleetCommand({
    scheduler: pollScheduler,
    tracker: asyncJobTracker,
    management,
    readTranscriptPage: context.root.readTranscriptPage,
    environment: context.root.environment,
  });
  return readyCommand(context.root, command);
};

export function createFleetCommand(
  deps: RegisterFleetCommandDeps,
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
