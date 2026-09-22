import { defineProvider, defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { SandboxExtensionDependencies } from '../../../../../types/extension';
import { brokeredProviderDeclarations } from '../_lib/sandboxProviders';

export default defineRoutedContribution(
  defineProvider((_context: PiPluginContext<SandboxExtensionDependencies>) =>
    brokeredProviderDeclarations(process.env),
  ),
  { cardinality: 'many' },
);
