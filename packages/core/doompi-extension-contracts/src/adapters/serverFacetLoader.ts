import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { DoomApiScope } from '../schemas/packageApi.ts';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  type DoomServerHostService,
  isDoomServerFacet,
} from '../schemas/serverFacet.ts';
import { packageApiDirectory } from './packageApiLoader.ts';

/** The generated module a host of this scope installs its facets from. */
export function serverFacetsModulePath(
  scope: DoomApiScope,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  explicitDirectory?: string,
): string {
  return path.join(packageApiDirectory(env, homeDir, explicitDirectory), `${scope}.facets.mjs`);
}

export interface LoadServerFacetsOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  apiDirectory?: string;
  onNotice?: (message: string) => void;
}

/**
 * The server facets a host of this scope should install, from the module
 * `doompi sync` generated.
 *
 * The failure posture matches the API loader's: no module is an ordinary state
 * on a fresh machine, and a module that fails to load costs the host its
 * facets but never its start. A server that refuses to boot over one broken
 * package is worse than a server missing that package's surface.
 */
export async function loadServerFacets(
  scope: DoomApiScope,
  options: LoadServerFacetsOptions = {},
): Promise<DoomServerFacet[]> {
  const notice = options.onNotice ?? ((): void => {});
  const environment = options.env ?? process.env;
  const modulePath = serverFacetsModulePath(scope, environment, options.homeDir ?? os.homedir(), options.apiDirectory);
  if (!fs.existsSync(modulePath)) return [];
  let exported: unknown;
  try {
    const module = (await import(pathToFileURL(modulePath).href)) as { facets?: unknown };
    exported = module.facets;
  } catch (error) {
    notice(`${scope} server facets are unavailable (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
  if (!Array.isArray(exported)) {
    notice(`${modulePath} exports no facets array; no ${scope} facet is installed`);
    return [];
  }
  const facets: DoomServerFacet[] = [];
  for (const candidate of exported) {
    if (!isDoomServerFacet(candidate)) {
      notice(`a ${scope} facet entry is not a server facet and is skipped`);
      continue;
    }
    facets.push(candidate);
  }
  return facets;
}

export interface InstallServerFacetsOptions {
  host: DoomServerHostService;
  facets: readonly DoomServerFacet[];
  onNotice?: (message: string) => void;
}

export interface InstalledServerFacets {
  /** The cordis root the facets were installed into, for a host that provides more services. */
  readonly root: Context;
  dispose(): Promise<void>;
}

/** Publishes the host service from inside a mounted plugin, so it unwinds with the root. */
function serverHostProvider(context: Context, host: DoomServerHostService): void {
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
}

/**
 * Installs server facets into a cordis root that provides the server host.
 *
 * A cordis root rather than plain calls, because a facet is a Doom
 * contribution like any other: it may inject services a host provides later,
 * and it unwinds through the same fiber disposal the Pi facet uses. One root
 * per host process, created here, so no host has to know cordis to run one.
 *
 * Facets are awaited one at a time and each is a single fiber, because a
 * facet declares its `inject` on itself. `fiber.await()` therefore settles
 * once `apply` has run, and the caller can read a complete mount table before
 * deciding whether to open a listener.
 */
export async function installServerFacets(options: InstallServerFacetsOptions): Promise<InstalledServerFacets> {
  const notice = options.onNotice ?? ((): void => {});
  const root = new Context();
  await root.plugin(serverHostProvider, options.host).await();
  for (const facet of options.facets) {
    try {
      await root.plugin(facet).await();
    } catch (error) {
      notice(`a server facet did not install (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return {
    root,
    dispose: async () => {
      await root.fiber.dispose();
    },
  };
}
