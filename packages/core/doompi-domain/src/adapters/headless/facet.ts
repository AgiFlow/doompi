import { readFile } from 'node:fs/promises';
import { listDomainNames } from '@agimon-ai/doompi-config/domains';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import {
  DOMAIN_COMMAND,
  domainToggleOptions,
  normalizeDomainNames,
  pickerTitle,
  splitDomains,
  toggledDomains,
  toggleOptionDomain,
} from '../../services/domainText.ts';

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
        const available = listDomainNames(execution.repoRoot);
        let requested = splitDomains(args);
        if (requested.length === 0) {
          const listing = {
            active: [...execution.selection.domains],
            effective: [...execution.selection.domains],
            available,
          };
          const selected = await execution.client.request({
            kind: 'select',
            title: pickerTitle(listing),
            options: domainToggleOptions(listing).map((label) => ({ label, value: label })),
          });
          if (typeof selected !== 'string' || !selected) return;
          requested = toggledDomains(listing.effective, toggleOptionDomain(selected));
        }
        requested = normalizeDomainNames(requested);
        const unknown = requested.filter((name) => !available.includes(name));
        if (unknown.length > 0) throw new Error(`Unknown domain: ${unknown.join(', ')}`);
        if (
          requested.length === execution.selection.domains.length &&
          requested.every((name, index) => name === execution.selection.domains[index])
        ) {
          return;
        }
        await host.select({ domains: requested });
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
