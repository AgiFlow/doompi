import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { createHeadlessReadTool } from '../readTool.ts';

export const readServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    requireDoomServerHost(context);
    const registrations = [] as Array<{ dispose(): void }>;
    const headless = readDoomHeadlessHost(context);
    if (headless) registrations.push(headless.registerTool(createHeadlessReadTool()));
    return () => {
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};

export default readServerFacet;
