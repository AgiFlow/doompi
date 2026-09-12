/**
 * doompi-git's server facet.
 *
 * The hub mounts the package API. A session host retains the same package's
 * headless tool and resources, gated by the active selection.
 */

import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { gitHeadlessFacet } from '../headless/facet.ts';
import { createWorktreesChannel } from '../web/worktreesChannel.ts';
import { api } from '../hubApi.ts';

export const gitServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    const headlessDisposer =
      host.scope === 'session' && readDoomHeadlessHost(context) ? gitHeadlessFacet.apply(context) : undefined;
    if (host.scope === 'session') return headlessDisposer;
    const registrations = [host.registerApi(api), host.registerChannel(createWorktreesChannel())];
    return () => {
      headlessDisposer?.();
      for (const registration of registrations.reverse()) registration.dispose();
    };
  },
};
