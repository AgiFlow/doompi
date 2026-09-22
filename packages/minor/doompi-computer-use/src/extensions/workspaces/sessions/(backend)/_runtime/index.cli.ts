import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

import { createComputerUseRuntime } from '../../../../../services/computerUseRuntime';
import { createComputerUseDependencies } from '../../../../../services/dependencies';
import type { ComputerUseExtensionDependencies } from '../../../../../types/extension';

export default (({ options, signal }) =>
  createComputerUseRuntime(options ?? createComputerUseDependencies(), signal)) satisfies (
  context: PiPluginContext<ComputerUseExtensionDependencies>,
) => PiPluginContributions<ComputerUseExtensionDependencies>;
