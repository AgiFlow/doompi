import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { SandboxExtensionDependencies } from '../../../../../types/extension';
import { createSandboxCliCommand } from '../_lib/sandboxCommands';
import type { SandboxPiScope } from '../_lib/sandboxScope';

export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<SandboxExtensionDependencies>, SandboxPiScope>) =>
    createSandboxCliCommand(context.root.service),
  {},
);
