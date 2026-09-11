import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  requireDoomServerHost,
  type DoomServerFacet,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { taskHeadlessFacet } from '../headless/facet.ts';
import { createTasksChannel } from '../webTasksChannel.ts';

/** Mounts Task's session host contributions or its hub-owned live channel. */
export const taskServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope === 'hub') {
      const registration = host.registerChannel(createTasksChannel());
      return () => registration.dispose();
    }
    return readDoomHeadlessHost(context) ? taskHeadlessFacet.apply(context) : undefined;
  },
};

export default taskServerFacet;
