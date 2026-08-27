import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  configLeafKeys,
  configScopeOf,
  mergeDoomConfigs,
  parseDoomConfig,
  valueAtKeyPath,
} from '../services/configPolicy.ts';
import type { DoomConfig } from '../types/config.ts';
import type { ConfigValueOrigin, DoomConfigLayer, DoomConfigLayers } from '../types/config.ts';

const DOOM_DIR = '.doom';
const CONFIG_FILE = 'config.yaml';
const GLOBAL_CONFIG_DIR = '.pi';
const PLANS_DIR = 'plans';

function readConfig(filePath: string): DoomConfig {
  return fs.existsSync(filePath)
    ? parseDoomConfig(fs.readFileSync(filePath, 'utf8'), filePath)
    : { projectTrust: 'ask' };
}

async function readConfigAsync(filePath: string): Promise<DoomConfig> {
  try {
    return parseDoomConfig(await fs.promises.readFile(filePath, 'utf8'), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projectTrust: 'ask' };
    throw error;
  }
}

export function globalDoomConfigDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, GLOBAL_CONFIG_DIR, DOOM_DIR);
}

export function globalDoomConfigPath(homeDirectory = os.homedir()): string {
  return path.join(globalDoomConfigDirectory(homeDirectory), CONFIG_FILE);
}

export function resolvePlanningPlansDirectory(
  configured: string | undefined,
  repoRoot: string,
  homeDirectory = os.homedir(),
): string {
  if (!configured) return path.join(homeDirectory, GLOBAL_CONFIG_DIR, PLANS_DIR);
  if (configured === '~') return homeDirectory;
  if (configured.startsWith('~/')) return path.resolve(homeDirectory, configured.slice(2));
  if (configured.startsWith('~')) {
    throw new Error("Doom planning plansDirectory supports only '~' or '~/' home aliases");
  }
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(repoRoot, configured);
}

export function repositoryDoomConfigPath(repoRoot: string): string {
  return path.join(repoRoot, DOOM_DIR, CONFIG_FILE);
}

export function loadDoomConfig(repoRoot: string, homeDirectory = os.homedir()): DoomConfig {
  return mergeDoomConfigs(
    readConfig(globalDoomConfigPath(homeDirectory)),
    readConfig(repositoryDoomConfigPath(repoRoot)),
  );
}

export async function loadDoomConfigAsync(repoRoot: string, homeDirectory = os.homedir()): Promise<DoomConfig> {
  const globalConfig = await readConfigAsync(globalDoomConfigPath(homeDirectory));
  const repositoryConfig = await readConfigAsync(repositoryDoomConfigPath(repoRoot));
  return mergeDoomConfigs(globalConfig, repositoryConfig);
}

/**
 * Reads one config file as a layer: what it is, what it sets, and the bytes it
 * held. A file that does not exist is a layer that sets nothing, which is a
 * normal state rather than an error.
 */
function readLayer(filePath: string): DoomConfigLayer {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { filePath, exists: false, hash: '', keys: [] };
    }
    throw error;
  }
  // The raw document, not the parsed config: this is the one read that has to
  // distinguish a key the file set from a key the parser defaulted.
  const document = (parseYaml(text) ?? {}) as unknown;
  return {
    filePath,
    exists: true,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    keys: configLeafKeys(document),
  };
}

/**
 * The two config files kept apart, with the merge alongside them.
 *
 * `repoRoot` is optional because the global file is complete on its own: a
 * settings surface with no repository in view still has settings to show, and
 * demanding one would leave it with nothing to render rather than with the
 * global half.
 *
 * The origin answer respects the merge's own per-field rules rather than simply
 * preferring the repository: `editor` is read from the global side whatever the
 * repository says, and `projectTrust` from the repository side whatever the
 * global one says. Reporting a file as the source of a value the merge discards
 * is the exact confusion this exists to remove.
 */
export function loadDoomConfigLayers(repoRoot: string | undefined, homeDirectory = os.homedir()): DoomConfigLayers {
  const globalLayer = readLayer(globalDoomConfigPath(homeDirectory));
  const repositoryLayer =
    repoRoot === undefined
      ? { filePath: '', exists: false, hash: '', keys: [] }
      : readLayer(repositoryDoomConfigPath(repoRoot));
  // With no repository there is nothing to merge, so the global file stands as
  // the effective config on its own.
  const effective =
    repoRoot === undefined
      ? mergeDoomConfigs(readConfig(globalDoomConfigPath(homeDirectory)), { projectTrust: 'ask' })
      : loadDoomConfig(repoRoot, homeDirectory);
  const sets = (layer: DoomConfigLayer, keyPath: readonly string[]): boolean => {
    const dotted = keyPath.join('.');
    return layer.keys.some((key) => key === dotted || key.startsWith(`${dotted}.`));
  };
  return {
    globalFile: globalLayer,
    repositoryFile: repositoryLayer,
    effective,
    originOf(keyPath: readonly string[]): ConfigValueOrigin {
      const scope = configScopeOf(keyPath);
      if (scope !== 'global' && sets(repositoryLayer, keyPath)) return 'repository';
      if (scope !== 'repository' && sets(globalLayer, keyPath)) return 'global';
      return 'default';
    },
    valueAt: (keyPath: readonly string[]) => valueAtKeyPath(effective, keyPath),
  };
}
