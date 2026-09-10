import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { loopHeadlessFacet } from '../headless/facet.ts';

export const loopServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope !== 'session' || !readDoomHeadlessHost(context)) return undefined;
    return loopHeadlessFacet.apply(context);
  },
};

export default loopServerFacet;
