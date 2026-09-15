import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import { defineCommand } from '@agimon-ai/doompi-core/pi-extension';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { COMMAND_DESCRIPTION, COMMAND_NAME } from '../../../../../constants/sandbox';
import type { SandboxExtensionService } from '../../../../../types/extension';
import type { SandboxServerScope } from './sandboxScope';

export function createSandboxCliCommand(
  service: SandboxExtensionService,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    COMMAND_NAME,
    {
      description: COMMAND_DESCRIPTION,
      async handler(_args, context) {
        const result = await service.execute();
        if (context.hasUI) context.ui.notify(result.message, result.level);
      },
    },
  ];
}

export function createSandboxServerCommands(context: WithRoot<DoomServerPluginContext, SandboxServerScope>) {
  const service = context.root.service;
  if (!service) return [];
  return [
    defineCommand({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      async execute() {
        const result = await service.execute();
        await context.agent?.context.client.notify({ body: result.message, level: result.level });
      },
    }),
  ];
}
