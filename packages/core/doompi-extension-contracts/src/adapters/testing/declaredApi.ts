import fs from 'node:fs';
import path from 'node:path';
import { declaredApisOf, type DoomApi, type DoomApiScope, isDoomApi } from '../../schemas/packageApi.ts';

import { declaredServerFacetsOf } from '../../schemas/serverFacet.ts';

/**
 * Checks a supplied API's shape and its package's declared host scope.
 *
 * New packages declare a server facet, so the API owns its base path and the
 * report names the facet's built entry. Package facet tests must separately
 * verify actual registration and disposal; this helper does not execute facets.
 * Explicit legacy manifest fixtures retain the old base-path comparison for
 * supported pre-descriptor generations.
 */

export interface DeclaredApiReport {
  basePath: string;
  scope: DoomApiScope;
  /** The built module a host would import, as the manifest names it. */
  dist: string;
}

export interface DeclaredApiExpectation {
  /** The package directory holding the server facet or legacy API declaration. */
  packageRoot: string;
  /** The API implementation supplied by the package test, not the facet export. */
  api: DoomApi;
  scope: DoomApiScope;
}

/**
 * Asserts API shape and scope admission, reporting the host entry without importing it.
 *
 * Throws rather than returning a verdict: each failure names the one thing to
 * fix, which is more use than a boolean to whoever reads it.
 */
export function assertDeclaredApi(expectation: DeclaredApiExpectation): DeclaredApiReport {
  const { api, packageRoot, scope } = expectation;
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const packageName = typeof manifest.name === 'string' ? manifest.name : packageRoot;

  if (!isDoomApi(api)) {
    throw new Error(
      `${packageName} exported something that is not a DoomApi: it needs a non-empty basePath and a start().`,
    );
  }
  if (manifest.doompiServer !== undefined) {
    const facet = declaredServerFacetsOf(packageRoot, manifest).find((candidate) => candidate.scopes.includes(scope));
    if (facet === undefined) throw new Error(`${packageName} declares no ${scope} server facet.`);
    return { basePath: api.basePath, scope, dist: facet.dist };
  }
  const declared = declaredApisOf(packageRoot, manifest);
  const block = declared.find((candidate) => candidate[scope] !== undefined);
  if (!block) {
    throw new Error(
      `${packageName} declares no ${scope} API in its doompiApi manifest, so no host of that scope mounts these routes.`,
    );
  }
  if (block.basePath !== api.basePath) {
    throw new Error(
      `${packageName} serves '${api.basePath}' but its manifest mounts the ${scope} API at '${block.basePath}'. ` +
        'Every client URL is built from the manifest, so no request would reach these routes.',
    );
  }
  return { basePath: block.basePath, scope, dist: block[scope]?.dist ?? '' };
}
