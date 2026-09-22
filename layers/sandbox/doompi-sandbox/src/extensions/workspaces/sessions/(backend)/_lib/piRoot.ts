import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { DefaultSandboxExtensionService } from '../../../../../services/extensionService';
import type { SandboxExtensionDependencies } from '../../../../../types/extension';
import type { SandboxPiScope } from './sandboxScope';

export function createSandboxPiRoot(context: PiPluginContext<SandboxExtensionDependencies>) {
  const value: SandboxPiScope = {
    service: context.options?.service ?? new DefaultSandboxExtensionService(process.env),
  };
  return { value };
}
