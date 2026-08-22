import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeDoomConfigs, parseDoomConfig } from '../services/configPolicy.ts';
import type { DoomConfig } from '../types/config.ts';

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
