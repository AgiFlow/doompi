/**
 * doompi-log's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host sees the declared injection before mounting the facet.
 * - Thin adapter. It registers the existing hub API and returns its disposer.
 * - Scope-aware. Log metrics belong to the cockpit hub, not one session server.
 *
 * AVOID:
 * - Starting I/O, timers, or independent state from this facet.
 */

import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import { readDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { logHeadlessFacet } from '../headless/facet.ts';
import { api } from '../hubApi.ts';

export const logServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    const headlessDisposer =
      host.scope === 'session' && readDoomHeadlessHost(context) ? logHeadlessFacet.apply(context) : undefined;
    if (host.scope !== 'hub') return headlessDisposer;
    const registration = host.registerApi(api);
    return () => {
      headlessDisposer?.();
      registration.dispose();
    };
  },
};
