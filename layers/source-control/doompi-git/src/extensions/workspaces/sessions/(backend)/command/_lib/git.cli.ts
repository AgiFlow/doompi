import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
// @scaffold-generated
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { COMMAND_NAME, COMMAND_DESCRIPTION } from '../../../../../../constants/git';
import type { GitExtensionDependencies, GitExtensionService } from '../../../../../../types/extension';
import type { GitPiScope } from '../../_lib/root.cli';

export function createGitCommand(
  service: GitExtensionService,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    COMMAND_NAME,
    {
      description: COMMAND_DESCRIPTION,
      handler: async (_args, ctx) => {
        const result = await service.execute();
        if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
      },
    },
  ];
}

export default (context: WithRoot<PiPluginContext<Partial<GitExtensionDependencies>>, GitPiScope>) =>
  createGitCommand(context.root.service);
