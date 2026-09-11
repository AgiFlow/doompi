/**
 * doompi-team's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing Team API owns all request behavior.
 * - Scope-aware. The Team catalog belongs to its owning agent session.
 *
 * AVOID:
 * - Starting work or retaining state in the facet lifecycle.
 */

import { readDoomHeadlessHost, type DoomHeadlessHostService } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { createSubagentCatalogChannel } from '../webSubagentCatalogChannel.ts';
import { createSubagentsChannel } from '../webSubagentsChannel.ts';
import { teamHeadlessFacet } from '../headless/facet.ts';
import { api } from '../teamCatalogApi.ts';

export const teamServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope === 'hub') {
      const registrations = [
        host.registerChannel(createSubagentsChannel()),
        host.registerChannel(createSubagentCatalogChannel()),
      ];
      return () => {
        for (const registration of registrations.reverse()) registration.dispose();
      };
    }
    const registration = host.registerApi(api);
    const headless = readDoomHeadlessHost(context) as DoomHeadlessHostService | undefined;
    const headlessDisposer = headless ? teamHeadlessFacet.apply(context) : undefined;
    return () => {
      headlessDisposer?.();
      registration.dispose();
    };
  },
};
