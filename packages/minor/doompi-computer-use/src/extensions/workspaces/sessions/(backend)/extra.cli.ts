import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import { createComputerUseRuntime } from '../../../../controllers/computerUseRuntime';
import { createComputerUseDependencies } from '../../../../services/dependencies';
import type { ComputerUseExtensionDependencies } from '../../../../types/extension';

export default (({ options, signal }) =>
  createComputerUseRuntime(options ?? createComputerUseDependencies(), signal)) satisfies (
  context: PiPluginContext<ComputerUseExtensionDependencies>,
) => PiPluginContributions<ComputerUseExtensionDependencies>;
