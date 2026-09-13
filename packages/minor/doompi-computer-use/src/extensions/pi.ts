import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createComputerUseRuntime } from '../controllers/computerUseRuntime';
import { createComputerUseDependencies } from '../services/dependencies';
import type { ComputerUseExtensionDependencies } from '../types/extension';
export const computerUseExtension = definePiExtension<ComputerUseExtensionDependencies>(
  '@agimon-ai/doompi-computer-use',
  ({ options, signal }) => createComputerUseRuntime(options ?? createComputerUseDependencies(), signal),
);
export default computerUseExtension;
