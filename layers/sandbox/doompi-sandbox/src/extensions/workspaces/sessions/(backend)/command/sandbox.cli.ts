import { defineCliCommand, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { SandboxExtensionDependencies } from '../../../../../types/extension';
import { createSandboxCliCommand } from '../_lib/sandboxCommands';
import type { SandboxPiScope } from '../_lib/sandboxScope';

export default defineCliCommand((context: WithRoot<PiPluginContext<SandboxExtensionDependencies>, SandboxPiScope>) =>
  createSandboxCliCommand(context.root.service),
);
