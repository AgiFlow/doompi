/**
 * doompi-git's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. `inject` is declared on the facet itself, so the host mounts
 *   one fiber and knows the API is registered the moment it settles.
 * - Thin host adapter. It registers the package's API and returns the
 *   disposer; the surface itself stays in hubApi.
 * - Scope-aware. Worktree operations span repositories the cockpit admitted,
 *   which only the hub knows, so the session scope registers nothing.
 *
 * AVOID:
 * - Starting work in apply. A facet that shells out at install has the same
 *   problem an eager Pi extension has, and the server has no reload to recover
 *   from it.
 */

import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { api } from '../hubApi.ts';

export const gitServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope !== 'hub') return undefined;
    const registration = host.registerApi(api);
    return () => registration.dispose();
  },
};
