import fs from 'node:fs';
import path from 'node:path';
import { declaredApisOf, type DoomApi, type DoomApiScope, isDoomApi } from '../../schemas/packageApi.ts';

/**
 * The one thing about a package API that only a running test can check.
 *
 * Vibe-Lint already reads the manifest statically: it proves the base path is
 * kebab-case, that the declared entry exists, that it exports `api`, and that
 * the built entry is in the files allowlist (`packageApiManifest`,
 * `packageApiEntry`). None of that reads the value, so none of it notices when
 * the routes and the manifest stop agreeing about where they are mounted.
 *
 * That disagreement is silent and total: `doompi sync` generates the route
 * module from the manifest, every client URL is built from the manifest, and
 * the routes answer under a different prefix, so nothing lands. The package's
 * own tests keep passing, because they call the app directly.
 *
 * The caller imports its own `api` normally and hands it over, so this needs
 * neither a dynamic import nor a build of the package under test.
 */

export interface DeclaredApiReport {
  basePath: string;
  scope: DoomApiScope;
  /** The built module a host would import, as the manifest names it. */
  dist: string;
}

export interface DeclaredApiExpectation {
  /** The package directory holding the package.json that declares the API. */
  packageRoot: string;
  /** The `api` this package exports from its declared entry. */
  api: DoomApi;
  scope: DoomApiScope;
}

/**
 * Asserts the manifest and the routes agree, and reports what a host would mount.
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
