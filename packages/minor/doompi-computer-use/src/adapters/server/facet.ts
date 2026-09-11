/**
 * doompi-computer-use's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing computer-use API owns request behavior.
 * - Scope-aware. Computer control belongs to its owning agent session.
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
import { computerUseHeadlessFacet } from '../headless/facet.ts';
import { createComputerUseChannel } from '../webComputerUseChannel.ts';
import { api } from '../computerUseApi.ts';

export const computerUseServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope === 'hub') {
      const registration = host.registerChannel(createComputerUseChannel());
      return () => registration.dispose();
    }
    const headlessDisposer = readDoomHeadlessHost(context) ? computerUseHeadlessFacet.apply(context) : undefined;
    if (host.scope !== 'session') return headlessDisposer;
    const registration = host.registerApi(api);
    return () => {
      headlessDisposer?.();
      registration.dispose();
    };
  },
};
