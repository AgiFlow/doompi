import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { createHeadlessGrepTool } from '../headless.ts';

export const grepServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    requireDoomServerHost(context);
    const headless = readDoomHeadlessHost(context);
    if (!headless) return undefined;
    const registration = headless.registerTool(createHeadlessGrepTool());
    return () => registration.dispose();
  },
};

export default grepServerFacet;
