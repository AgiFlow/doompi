import { listDomainNames } from '@agimon-ai/doompi-config/domains';
import { type DoomHeadlessCommand, type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { DOOM_RESOURCE_CATALOG_ENTRY_TYPE, type ResourceCatalogProjection } from '@agimon-ai/doompi-core/skills';

import {
  DOMAIN_COMMAND,
  domainToggleOptions,
  normalizeDomainNames,
  pickerTitle,
  splitDomains,
  toggledDomains,
  toggleOptionDomain,
} from '../../../../../services/domainText';

export function createDomainServerCommand(host: DoomHeadlessHostService): DoomHeadlessCommand {
  return {
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
      await host.changeSelection({ axis: 'domains', domains: requested });
      // The web composer caches get_commands for `$` completion. Signal only after
      // the headless host has reconciled commands so the re-read sees this selection.
      const projection: ResourceCatalogProjection = { version: 1, revision: Date.now() };
      await execution.session.appendCustomEntry(DOOM_RESOURCE_CATALOG_ENTRY_TYPE, projection);
    },
  };
}
