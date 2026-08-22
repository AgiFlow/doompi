import { type DoomHelpContributionHandle, type DoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';

export function registerDoomConfigHelp(service: DoomHelpService): DoomHelpContributionHandle {
  return service.register({
    source: '@agimon-ai/doompi-config',
    moduleUrl: import.meta.url,
    skills: [
      {
        name: 'doompi-author-config',
        description:
          'Configure DoomPi runtime settings, source precedence, and typed session configuration. Use for config.yaml, the doom/config Cordis service, immutable context snapshots, or shared selection transition state. Do not use for defining modes.yaml, domains.yaml, or profiles.yaml.',
      },
    ],
  });
}
