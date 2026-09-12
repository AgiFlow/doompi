/**
 * doompi-author's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing Author API owns all request behavior.
 * - Scope-aware. Author state belongs to the session that owns the document.
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
import { authorHeadlessFacet } from '../headless/facet.ts';
import { createAuthorChannel } from '../webAuthorChannel.ts';
import { api } from '../authorApi.ts';

export const authorServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope === 'global' || host.scope === 'workspace') {
      const registration = host.registerChannel(createAuthorChannel());
      return () => registration.dispose();
    }
    const headlessDisposer = readDoomHeadlessHost(context) ? authorHeadlessFacet.apply(context) : undefined;
    if (host.scope !== 'session') return headlessDisposer;
    const registration = host.registerApi(api);
    return () => {
      headlessDisposer?.();
      registration.dispose();
    };
  },
};
