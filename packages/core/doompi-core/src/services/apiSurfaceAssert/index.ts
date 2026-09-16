/**
 * Checks that what a package declares is what it actually serves.
 *
 * Nothing else in the toolchain does. `parseApiContract` checks a contract's
 * shape, its id uniqueness and that it is JSON, and stops there; no step
 * compares it to a mounted route or to a registration. That gap is not
 * theoretical. One package shipped a valid four-route contract, a well-tested
 * Hono app and a full unit suite for an API that was never mounted at all, and
 * the only test touching the mount asserted the emptiness rather than noticing
 * it.
 *
 * Two questions, both about liveness rather than semantics: are the base paths
 * this scope registers the same set it declares, and does every declared route
 * reach a handler. A route answering 500 passes; a route answering 404 or 405
 * does not exist.
 */

import type { DoomApiContract } from '../../schemas/apiContracts';
import type { DoomApi, DoomApiScope } from '../../schemas/packageApi';
import { mountPackageApi, type MountPackageApiOptions } from '../packageApiHarness';

export interface ApiSurfaceOptions {
  readonly contract: DoomApiContract;
  /** The scope being checked; only its declarations and registrations are compared. */
  readonly scope: DoomApiScope;
  /** What the generated facet registered at this scope, in registration order. */
  readonly apis: readonly DoomApi[];
  /** Passed through to the harness, so a session API gets its id and working directory. */
  readonly mount?: Omit<MountPackageApiOptions, 'scope'>;
  /**
   * Extra request detail for a route a bare request cannot reach, keyed by
   * contract id. A route needing a body reports 400, which passes; one needing
   * a path parameter substituted would report 404, which does not.
   */
  readonly probe?: Readonly<Record<string, RequestInit & { readonly path?: string }>>;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Throws with the disagreement spelled out, or returns having found none. */
export async function assertContractSurface(options: ApiSurfaceOptions): Promise<void> {
  const routes = options.contract.http.filter((route) => route.scope === options.scope && route.basePath !== undefined);
  const declared = sorted(routes.map((route) => route.basePath as string));
  const registered = sorted(options.apis.map((api) => api.basePath));

  const missing = declared.filter((basePath) => !registered.includes(basePath));
  if (missing.length > 0) {
    throw new Error(
      `The contract declares ${missing.join(', ')} at ${options.scope} scope, but nothing is mounted there. ` +
        `Mounted: ${registered.join(', ') || '(nothing)'}.`,
    );
  }
  const undeclared = registered.filter((basePath) => !declared.includes(basePath));
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.join(', ')} is mounted at ${options.scope} scope but the contract never declares it there.`,
    );
  }

  for (const api of options.apis) {
    const mounted = mountPackageApi(api, { ...options.mount, scope: options.scope });
    try {
      for (const route of routes.filter((entry) => entry.basePath === api.basePath)) {
        const probe = options.probe?.[route.id];
        const path = probe?.path ?? route.path;
        const response = await mounted.fetch(`${mounted.mountPath}${path === '/' ? '' : path}`, {
          method: route.method,
          ...probe,
        });
        if (response.status === 404 || response.status === 405) {
          throw new Error(
            `${route.method} ${mounted.mountPath}${path} is declared as '${route.id}' but answered ` +
              `${response.status}, so no handler serves it.`,
          );
        }
      }
    } finally {
      mounted.close();
    }
  }
}
