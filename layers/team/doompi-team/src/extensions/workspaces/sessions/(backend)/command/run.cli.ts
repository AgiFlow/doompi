import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { extractForkFlag, parseAgentToken } from '../../../../../services/chainExpression';
import type { TeamPiScope } from '../root.cli';
import { launchSingleAgentRun, notifyError, type SlashCommandDeps, type SlashCommandState } from './_lib/launch';
import { readyCommand } from './_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  readyCommand(context.root, createRunCommand(context.pi, context.root.state, context.root.slashCommandDeps));

export function createRunCommand(
  pi: ExtensionAPI,
  state: SlashCommandState,
  deps: SlashCommandDeps,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    'run',
    {
      description: 'Run a subagent in the background: /run agent[model=x] [task] [--fork]',
      handler: async (args, ctx) => {
        const { args: cleanedArgs, fork } = extractForkFlag(args);
        const input = cleanedArgs.trim();
        if (!input) {
          notifyError(ctx, 'Usage: /run <agent> [task] [--fork]');
          return;
        }
        const firstSpace = input.indexOf(' ');
        const { name: agentName, config } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
        const task = firstSpace === -1 ? '' : input.slice(firstSpace + 1).trim();
        const outcome = await launchSingleAgentRun(pi, ctx, state, deps, { agent: agentName, task, config, fork });
        if (!outcome.ok) notifyError(ctx, outcome.message);
      },
    },
  ];
}
