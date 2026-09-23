import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { TeamPiScope } from '../../_lib/root.cli';
import {
  notifyError,
  notifyInfo,
  sessionScopeFor,
  type SlashCommandDeps,
  type SlashCommandState,
} from '.././_lib/launch';
import { readyCommand } from '.././_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  readyCommand(context.root, createSteerCommand(context.pi, context.root.state, context.root.slashCommandDeps));

export function createSteerCommand(
  _pi: ExtensionAPI,
  _state: SlashCommandState,
  deps: SlashCommandDeps,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    'subagents-steer',
    {
      description: 'Send guidance to a running subagent: /subagents-steer <run-id> <message>',
      handler: async (args, ctx) => {
        const input = args.trim();
        const separator = input.search(/\s/);
        if (separator === -1 || !input.slice(separator + 1).trim()) {
          notifyError(ctx, 'Usage: /subagents-steer <run-id> <message>');
          return;
        }
        const id = input.slice(0, separator);
        const message = input.slice(separator + 1).trim();
        try {
          deps.management.bindSessionScope(sessionScopeFor(ctx, deps.environment));
          const result = await deps.management.steer(id, message);
          const summary = `Steering ${result.state} for ${id}: ${result.message}`;
          if (result.state === 'failed') notifyError(ctx, summary);
          else notifyInfo(ctx, summary);
        } catch (error) {
          notifyError(ctx, error instanceof Error ? error.message : `Could not steer '${id}'.`);
        }
      },
    },
  ];
}
