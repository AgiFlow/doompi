/**
 * doom-runner's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. `inject` is declared on the facet itself, so the host mounts
 *   one fiber and knows the API is registered the moment it settles.
 * - Thin host adapter. It registers the package's API and returns the
 *   disposer; the surface itself stays in runnerLogApi.
 * - Scope-aware. The runner's log surface belongs to the session that owns the
 *   runners, so the hub scope registers nothing rather than mounting an API
 *   with no session behind it.
 *
 * AVOID:
 * - Starting work in apply. A facet that opens files or timers at install has
 *   the same problem an eager Pi extension has, and the server has no reload
 *   to recover from it.
 */

import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { api } from '../runnerLogApi.ts';

export const runnerServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    if (host.scope !== 'session') return undefined;
    const registration = host.registerApi(api);
    return () => registration.dispose();
  },
};
