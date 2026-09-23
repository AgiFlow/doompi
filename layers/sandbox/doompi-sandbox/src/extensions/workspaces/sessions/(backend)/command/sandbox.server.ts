import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createSandboxServerCommands } from '../_lib/sandboxCommands';
import type { SandboxServerScope } from '../_lib/sandboxScope';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, SandboxServerScope>) => createSandboxServerCommands(context),
  { cardinality: 'many' },
);
