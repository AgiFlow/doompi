/**
 * doompi-plan's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing plan API owns all request behavior.
 * - Scope-aware. The current plan belongs to its owning agent session.
 *
 * AVOID:
 * - Starting work or retaining state in the facet lifecycle.
 */

import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { planHeadlessFacet } from '../headless/facet.ts';
import { api } from '../planApi.ts';

export const planServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    const headlessDisposer =
      host.scope === 'session' && readDoomHeadlessHost(context) ? planHeadlessFacet.apply(context) : undefined;
    if (host.scope !== 'session') return headlessDisposer;
    const registration = host.registerApi(api);
    return () => {
      headlessDisposer?.();
      registration.dispose();
    };
  },
};
