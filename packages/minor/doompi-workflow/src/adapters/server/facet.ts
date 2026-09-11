/**
 * doompi-workflow's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host sees the declared injection before mounting the facet.
 * - Thin adapter. It registers the existing hub API and returns its disposer.
 * - Scope-aware. Workflow runs span repositories admitted by the cockpit hub.
 *
 * AVOID:
 * - Starting I/O, timers, or independent state from this facet.
 */

import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { workflowHeadlessFacet } from '../headless/facet.ts';
import { createWorkflowsChannel } from '../workflowsHubChannel.ts';
import { createWorkflowCatalogChannel } from '../workflowCatalogChannel.ts';
import { api } from '../workflowHubApi.ts';

export const workflowServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    const headlessDisposer =
      host.scope === 'session' && readDoomHeadlessHost(context) ? workflowHeadlessFacet.apply(context) : undefined;
    if (host.scope !== 'hub') return headlessDisposer;
    const registrations = [
      host.registerApi(api),
      host.registerChannel(createWorkflowsChannel()),
      host.registerChannel(createWorkflowCatalogChannel()),
    ];
    return () => {
      headlessDisposer?.();
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};
