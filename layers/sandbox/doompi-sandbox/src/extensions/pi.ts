import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createSandboxCommand } from '../controllers/doomSandboxCommand';
import { brokeredProviderOverrides } from '../services/brokerProviders';
import { DefaultSandboxExtensionService } from '../services/extensionService';
import type { SandboxExtensionDependencies } from '../types/extension';
export const activateSandboxExtension = definePiExtension<SandboxExtensionDependencies>(
  '@agimon-ai/doompi-sandbox',
  ({ options }) => ({
    commands: [createSandboxCommand(options?.service ?? new DefaultSandboxExtensionService(process.env))],
    providers: brokeredProviderOverrides(process.env).map(({ provider, baseUrl }) => [provider, { baseUrl }] as const),
    resources: [
      {
        source: '@agimon-ai/doompi-sandbox',
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-use-sandbox',
            description:
              'Use @agimon-ai/doompi-sandbox: Container sandbox for DoomPi launches: the agent, extensions, and tools run inside Docker or Podman while the terminal stays on the host',
          },
        ],
      },
    ],
  }),
);
export default activateSandboxExtension;
