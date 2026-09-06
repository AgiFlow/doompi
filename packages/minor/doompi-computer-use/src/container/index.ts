import path from 'node:path';
import { loadDoomConfig } from '@agimon-ai/doompi-config';
import { createComputerUseSessionClient } from '../adapters/pi/sessionApiClient.ts';
import { ComputerScriptRunner } from '../adapters/pi/computerScriptRunner.ts';
import { DefaultComputerUseExtensionService } from '../services/extensionService.ts';
import type { ComputerUseExtensionDependencies } from '../types/extension.ts';

export const COMPUTER_USE_SCRIPT_PATHS_ENV = 'DOOMPI_COMPUTER_USE_SCRIPT_PATHS';
export function createComputerUseContainer(
  overrides: Partial<ComputerUseExtensionDependencies> = {},
): ComputerUseExtensionDependencies {
  const client = overrides.client ?? createComputerUseSessionClient();
  const allowedScriptPaths = (process.env[COMPUTER_USE_SCRIPT_PATHS_ENV] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  return {
    service: overrides.service ?? new DefaultComputerUseExtensionService(client),
    enabled:
      overrides.enabled ??
      (() => loadDoomConfig(process.env.PI_PROJECT_ROOT ?? process.cwd()).computerUse?.enabled === true),
    ...(client === undefined ? {} : { client }),
    ...(overrides.scriptRunner !== undefined
      ? { scriptRunner: overrides.scriptRunner }
      : client === undefined
        ? {}
        : { scriptRunner: new ComputerScriptRunner({ client, allowedScriptPaths }) }),
  };
}
