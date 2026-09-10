/**
 * DoomPi core's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing context API owns all request behavior.
 * - Scope-aware. Context details belong to the agent session that produced them.
 *
 * AVOID:
 * - Starting work or retaining state in the facet lifecycle.
 */

import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { api } from '../contextApi.ts';

export const doompiServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope !== 'session') return undefined;
    const registration = host.registerApi(api);
    return () => registration.dispose();
  },
};
