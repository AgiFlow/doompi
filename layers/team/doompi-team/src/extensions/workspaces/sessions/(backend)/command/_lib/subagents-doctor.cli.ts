import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { buildDoctorReport } from '../../../../../../services/doctor';
import type { TeamPiScope } from '../../_lib/root.cli';
import { sendSlashText, sessionScopeFor, type SlashCommandDeps, type SlashCommandState } from '.././_lib/launch';
import { readyCommand } from '.././_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  readyCommand(context.root, createDoctorCommand(context.pi, context.root.state, context.root.slashCommandDeps));

export function createDoctorCommand(
  pi: ExtensionAPI,
  _state: SlashCommandState,
  deps: SlashCommandDeps,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    'subagents-doctor',
    {
      description: 'Show subagent diagnostics',
      handler: async (_args, ctx) => {
        sendSlashText(
          pi,
          buildDoctorReport(
            { cwd: ctx.cwd, agentScope: 'both', scope: sessionScopeFor(ctx, deps.environment) },
            { discovery: deps.discovery, skills: deps.skills },
          ),
        );
      },
    },
  ];
}
