import { loadDoomConfig } from '@agimon-ai/doompi-config';
import { createComputerUseSessionClient } from '../adapters/pi/sessionApiClient.ts';
import { DefaultComputerUseExtensionService } from '../services/extensionService.ts';
import type { ComputerUseExtensionDependencies } from '../types/extension.ts';

export function createComputerUseContainer(
  overrides: Partial<ComputerUseExtensionDependencies> = {},
): ComputerUseExtensionDependencies {
  const client = overrides.client ?? createComputerUseSessionClient();
  return {
    service: overrides.service ?? new DefaultComputerUseExtensionService(client),
    enabled:
      overrides.enabled ??
      (() => loadDoomConfig(process.env.PI_PROJECT_ROOT ?? process.cwd()).computerUse?.enabled === true),
    ...(client === undefined ? {} : { client }),
  };
}
