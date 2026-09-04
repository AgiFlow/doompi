import { createComputerUseSessionClient } from '../adapters/pi/sessionApiClient.ts';
import { DefaultComputerUseExtensionService } from '../services/extensionService.ts';
import type { ComputerUseExtensionDependencies } from '../types/extension.ts';

export function createComputerUseContainer(
  overrides: Partial<ComputerUseExtensionDependencies> = {},
): ComputerUseExtensionDependencies {
  const client = overrides.client ?? createComputerUseSessionClient();
  return {
    service: overrides.service ?? new DefaultComputerUseExtensionService(client),
    ...(client === undefined ? {} : { client }),
  };
}
