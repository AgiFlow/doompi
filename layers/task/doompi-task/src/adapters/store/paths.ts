import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';

export const STORE_PATH_ENV = 'DOOM_TASK_STORE';

const STORE_DIR_NAME = 'doom-task';
const STORE_FILE_NAME = 'tasks.json';
const DEFAULT_CONFIG_DIR_NAME = '.pi';
const AGENT_DIR_NAME = 'agent';
const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const HOME_ALIAS = '~';
const HOME_ALIAS_PREFIX = '~/';
const FILE_ENCODING = 'utf8';
const NOT_FOUND_ERROR_CODE = 'ENOENT';

function git(args: string[], cwd: string): string | undefined {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: FILE_ENCODING,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function gitAsync(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: FILE_ENCODING }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : undefined);
    });
  });
}

function resolveAgentDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env[PI_CODING_AGENT_DIR_ENV]?.trim();
  if (configured === HOME_ALIAS) return os.homedir();
  if (configured?.startsWith(HOME_ALIAS_PREFIX)) {
    return path.join(os.homedir(), configured.slice(HOME_ALIAS_PREFIX.length));
  }
  return configured ? path.resolve(configured) : path.join(os.homedir(), DEFAULT_CONFIG_DIR_NAME, AGENT_DIR_NAME);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve the tree root without relying on extension startup order. */
export function resolveSessionKey(rootSessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!env[SUBAGENT_CHILD_ENV]) return rootSessionId;
  const parentSessionId = env[SUBAGENT_PARENT_SESSION_ENV]?.trim();
  if (!parentSessionId) throw new Error(`${SUBAGENT_PARENT_SESSION_ENV} is required in a subagent child`);
  return parentSessionId;
}

/** Resolve one root session tree to a task document under the Pi agent directory. */
export function resolveStorePath(
  _cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  sessionKey: string = 'standalone',
): string {
  const override = env[STORE_PATH_ENV]?.trim();
  if (override) return path.resolve(override);

  const trimmedSessionKey = sessionKey.trim();
  if (!trimmedSessionKey) throw new Error('doom-task session id cannot be blank');
  return path.join(resolveAgentDirectory(env), STORE_DIR_NAME, trimmedSessionKey, STORE_FILE_NAME);
}

/** Whether a deliberate unscoped task-store override is active. */
export function hasStorePathOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[STORE_PATH_ENV]?.trim());
}

/** Exact legacy Git-directory store, if the current working tree has one. */
export function resolveLegacyStoreDirectory(cwd: string = process.cwd()): string | undefined {
  const commonDirectory = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDirectory ? path.join(commonDirectory, STORE_DIR_NAME) : undefined;
}

export async function resolveLegacyStoreDirectoryAsync(cwd: string = process.cwd()): Promise<string | undefined> {
  const commonDirectory = await gitAsync(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDirectory ? path.join(commonDirectory, STORE_DIR_NAME) : undefined;
}

export interface StoreSweepResult {
  removed: string[];
  errors: string[];
}

/** Remove only the validated legacy Git store unless it contains the active override. */
export function removeLegacyStoreDirectory(currentStorePath: string, cwd: string = process.cwd()): StoreSweepResult {
  const result: StoreSweepResult = { removed: [], errors: [] };
  const target = resolveLegacyStoreDirectory(cwd);
  if (!target || path.basename(target) !== STORE_DIR_NAME || isWithin(target, currentStorePath)) return result;

  try {
    if (!fs.existsSync(target)) return result;
    fs.rmSync(target, { recursive: true, force: true });
    result.removed.push(target);
  } catch (error) {
    result.errors.push(`Could not remove legacy task store ${target}: ${String(error)}`);
  }
  return result;
}

export async function removeLegacyStoreDirectoryAsync(
  currentStorePath: string,
  cwd: string = process.cwd(),
): Promise<StoreSweepResult> {
  const result: StoreSweepResult = { removed: [], errors: [] };
  const target = await resolveLegacyStoreDirectoryAsync(cwd);
  if (!target || path.basename(target) !== STORE_DIR_NAME || isWithin(target, currentStorePath)) return result;

  try {
    await fs.promises.access(target);
    await fs.promises.rm(target, { recursive: true, force: true });
    result.removed.push(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
      result.errors.push(`Could not remove legacy task store ${target}: ${String(error)}`);
    }
  }
  return result;
}

/** Delete expired sibling session stores while preserving active or unreadable stores. */
export function sweepStoreFiles(currentStorePath: string, ttlMs: number, now: number = Date.now()): StoreSweepResult {
  const result: StoreSweepResult = { removed: [], errors: [] };
  const currentSessionDirectory = path.dirname(currentStorePath);
  const storeDirectory = path.dirname(currentSessionDirectory);
  let entries: string[];
  try {
    entries = fs.readdirSync(storeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === NOT_FOUND_ERROR_CODE) return result;
    result.errors.push(`Could not read task store directory ${storeDirectory}: ${String(error)}`);
    return result;
  }

  for (const entry of entries) {
    const sessionDirectory = path.join(storeDirectory, entry);
    const candidate = path.join(sessionDirectory, STORE_FILE_NAME);
    if (sessionDirectory === currentSessionDirectory || !fs.existsSync(candidate)) continue;
    try {
      if (fs.existsSync(lockPathFor(candidate))) continue;
      JSON.parse(fs.readFileSync(candidate, FILE_ENCODING));
      if (now - fs.statSync(candidate).mtimeMs <= ttlMs) continue;
      fs.rmSync(sessionDirectory, { recursive: true, force: true });
      result.removed.push(sessionDirectory);
    } catch (error) {
      result.errors.push(`Could not sweep task store ${candidate}: ${String(error)}`);
    }
  }
  return result;
}

export async function sweepStoreFilesAsync(
  currentStorePath: string,
  ttlMs: number,
  now: number = Date.now(),
): Promise<StoreSweepResult> {
  const result: StoreSweepResult = { removed: [], errors: [] };
  const currentSessionDirectory = path.dirname(currentStorePath);
  const storeDirectory = path.dirname(currentSessionDirectory);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(storeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === NOT_FOUND_ERROR_CODE) return result;
    result.errors.push(`Could not read task store directory ${storeDirectory}: ${String(error)}`);
    return result;
  }

  for (const entry of entries) {
    const sessionDirectory = path.join(storeDirectory, entry);
    const candidate = path.join(sessionDirectory, STORE_FILE_NAME);
    if (sessionDirectory === currentSessionDirectory) continue;
    try {
      await fs.promises.access(candidate);
      try {
        await fs.promises.access(lockPathFor(candidate));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) throw error;
      }
      JSON.parse(await fs.promises.readFile(candidate, FILE_ENCODING));
      if (now - (await fs.promises.stat(candidate)).mtimeMs <= ttlMs) continue;
      await fs.promises.rm(sessionDirectory, { recursive: true, force: true });
      result.removed.push(sessionDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === NOT_FOUND_ERROR_CODE) continue;
      result.errors.push(`Could not sweep task store ${candidate}: ${String(error)}`);
    }
  }
  return result;
}

export function lockPathFor(storePath: string): string {
  return `${storePath}.lock`;
}

export function tempPathFor(storePath: string, pid: number = process.pid): string {
  return `${storePath}.tmp.${pid}`;
}
