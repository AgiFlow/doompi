import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type DoomApi, type DoomApiScope, isDoomApi } from '../schemas/packageApi.ts';

/** Where `doompi sync` publishes the generated route modules. */
const API_DIR_NAME = 'api';
const CURRENT_DIR_NAME = 'current';
const DOOMPI_HOME = '.doompi';
/** Env override, so a test or a second composition can point a host elsewhere. */
export const PACKAGE_API_DIR_ENV = 'DOOMPI_API_DIR';

/** The directory holding the generated modules for this machine. */
export function packageApiDirectory(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const override = env[PACKAGE_API_DIR_ENV];
  if (override !== undefined && override !== '') return path.resolve(override);
  return path.join(homeDir, DOOMPI_HOME, API_DIR_NAME, CURRENT_DIR_NAME);
}

/** The generated module a host of this scope imports. */
export function packageApiModulePath(
  scope: DoomApiScope,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  return path.join(packageApiDirectory(env, homeDir), `${scope}.routes.mjs`);
}

export interface LoadPackageApisOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  onNotice?: (message: string) => void;
}

/**
 * The APIs a host of this scope should mount, from the module `doompi sync`
 * generated.
 *
 * No module means nothing has been synced yet, which is an ordinary state for a
 * fresh machine and not worth a notice. A module that fails to load is: the
 * host says so and serves nothing, rather than refusing to start, because a
 * broken package must not cost a session its agent.
 */
export async function loadPackageApis(scope: DoomApiScope, options: LoadPackageApisOptions = {}): Promise<DoomApi[]> {
  const notice = options.onNotice ?? ((): void => {});
  const modulePath = packageApiModulePath(scope, options.env ?? process.env, options.homeDir ?? os.homedir());
  if (!fs.existsSync(modulePath)) return [];
  let exported: unknown;
  try {
    const module = (await import(pathToFileURL(modulePath).href)) as { apis?: unknown };
    exported = module.apis;
  } catch (error) {
    notice(`${scope} package APIs are unavailable (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
  if (!Array.isArray(exported)) {
    notice(`${modulePath} exports no apis array; no ${scope} API is mounted`);
    return [];
  }
  const seen = new Set<string>();
  const apis: DoomApi[] = [];
  for (const candidate of exported) {
    if (!isDoomApi(candidate)) {
      notice(`a ${scope} API entry is not a package API and is skipped`);
      continue;
    }
    if (seen.has(candidate.basePath)) {
      notice(`duplicate package API base path '${candidate.basePath}' dropped; base paths are global`);
      continue;
    }
    seen.add(candidate.basePath);
    apis.push(candidate);
  }
  return apis;
}
