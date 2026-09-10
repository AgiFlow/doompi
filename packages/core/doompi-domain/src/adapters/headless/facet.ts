import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { DOMAIN_COMMAND, splitDomains } from '../../services/domainText.ts';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

function domainMetadata(execution: { readonly selection: { readonly domains: readonly string[] } }): string {
  return JSON.stringify({ domains: execution.selection.domains });
}

async function readFileOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export const domainHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resources: DoomHeadlessResource[] = [
      {
        name: 'doompi/domain-config',
        kind: 'context',
        read: (execution) => domainMetadata(execution),
      },
      {
        name: 'doompi-author-domain',
        kind: 'skill',
        read: () =>
          readFileOrFallback(
            new URL('src/prompts/doompi-author-domain/SKILL.md', PACKAGE_ROOT).pathname,
            '(resource unavailable)',
          ),
      },
    ];
    const command: DoomHeadlessCommand = {
      name: DOMAIN_COMMAND,
      description: 'Show or change the active DoomPi domains.',
      async execute(args, execution) {
        const trimmed = args.trim();
        if (!trimmed) {
          await execution.client.notify({
            title: 'DoomPi domains',
            body: `Active domains: ${execution.selection.domains.join(', ') || '(none)'}`,
            level: 'info',
          });
          return;
        }
        await host.select({ domains: splitDomains(trimmed) });
      },
    };
    const registrations = [
      ...resources.map((resource) => host.registerResource(resource)),
      host.registerCommand(command),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
