import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IRunnerPaths, LogSweepResult } from '../services/RunnerPaths/types.ts';
import { inheritedSessionId } from '../services/runs/session.ts';
import { LOG_DIR_ENV } from '../types/config.ts';

const STORE_DIR_NAME = 'doom-runner';
const DEFAULT_CONFIG_DIR_NAME = '.pi';
const AGENT_DIR_NAME = 'agent';
const LOG_DIR_NAME = 'logs';
const STATE_DIR_NAME = 'runs';
const LOG_EXTENSION = '.log';
const STATE_EXTENSION = '.json';
const ROTATED_SUFFIX = '.1';
const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const HOME_ALIAS = '~';
const HOME_ALIAS_PREFIX = '~/';
const FILE_ENCODING = 'utf8';
const NOT_FOUND_ERROR_CODE = 'ENOENT';

function git(args: string[], cwd: string): string | undefined {
  try {
    const output = execFileSync('git', args, { cwd, encoding: FILE_ENCODING, stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function resolveAgentDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env[PI_CODING_AGENT_DIR_ENV]?.trim();
  if (configured === HOME_ALIAS) return os.homedir();
  if (configured?.startsWith(HOME_ALIAS_PREFIX)) {
    return path.join(os.homedir(), configured.slice(HOME_ALIAS_PREFIX.length));
  }
  return configured ? path.resolve(configured) : path.join(os.homedir(), DEFAULT_CONFIG_DIR_NAME, AGENT_DIR_NAME);
}

/**
 * Newest mtime anywhere one level inside the session, falling back to the
 * directory itself. A session still being written to therefore always looks
 * recent, whatever state its individual records are in.
 */
function newestEntryTime(directory: string): number {
  let newest = fs.statSync(directory).mtimeMs;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    newest = Math.max(newest, fs.statSync(target).mtimeMs);
    if (!entry.isDirectory()) continue;
    for (const child of fs.readdirSync(target)) {
      newest = Math.max(newest, fs.statSync(path.join(target, child)).mtimeMs);
    }
  }
  return newest;
}

async function newestEntryTimeAsync(directory: string): Promise<number> {
  let newest = (await fs.promises.stat(directory)).mtimeMs;
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    newest = Math.max(newest, (await fs.promises.stat(target)).mtimeMs);
    if (!entry.isDirectory()) continue;
    for (const child of await fs.promises.readdir(target)) {
      newest = Math.max(newest, (await fs.promises.stat(path.join(target, child))).mtimeMs);
    }
  }
  return newest;
}

/**
 * Whether any run in this session names a pi process that is still running.
 *
 * One live record is enough: records are only ever written by their owner, so a
 * live host pid means the session is still in use however old its files look.
 */
function ownerAlive(stateDirectory: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDirectory);
  } catch {
    // No records left to consult, so nothing claims the directory.
    return false;
  }

  for (const entry of entries) {
    if (!entry.endsWith(STATE_EXTENSION)) continue;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(stateDirectory, entry), FILE_ENCODING));
      const hostPid = (value as { hostPid?: unknown }).hostPid;
      if (typeof hostPid !== 'number') continue;
      process.kill(hostPid, 0);
      return true;
    } catch {
      // An unreadable record and a dead pid mean the same thing here: no claim.
    }
  }
  return false;
}

async function ownerAliveAsync(stateDirectory: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(stateDirectory);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.endsWith(STATE_EXTENSION)) continue;
    try {
      const value: unknown = JSON.parse(await fs.promises.readFile(path.join(stateDirectory, entry), FILE_ENCODING));
      const hostPid = (value as { hostPid?: unknown }).hostPid;
      if (typeof hostPid !== 'number') continue;
      process.kill(hostPid, 0);
      return true;
    } catch {
      // An unreadable record and a dead pid mean the same thing here: no claim.
    }
  }
  return false;
}

function completedAt(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { state?: unknown; exit?: { finishedAt?: unknown } };
  if (record.state !== 'completed' || typeof record.exit?.finishedAt !== 'string') return undefined;
  const timestamp = Date.parse(record.exit.finishedAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Session-scoped runner storage under the Pi agent directory. */
export class RunnerPaths implements IRunnerPaths {
  private adoptedSessionId: string | undefined;
  private repository: string | undefined;

  repositoryPath(): string {
    this.repository ??= realPath(git(['rev-parse', '--show-toplevel'], process.cwd()) ?? process.cwd());
    return this.repository;
  }

  setSessionId(sessionId: string): void {
    const trimmed = sessionId.trim();
    if (!trimmed) throw new Error('doom-runner session id cannot be blank');
    this.adoptedSessionId = trimmed;
  }

  logDirectory(sessionId?: string): string {
    const override = process.env[LOG_DIR_ENV]?.trim();
    if (override) return path.resolve(override);
    return path.join(this.sessionDirectory(sessionId), LOG_DIR_NAME);
  }

  stateDirectory(sessionId?: string): string {
    const override = process.env[LOG_DIR_ENV]?.trim();
    if (override) return path.join(path.resolve(override), '..', STATE_DIR_NAME);
    return path.join(this.sessionDirectory(sessionId), STATE_DIR_NAME);
  }

  logPathFor(id: string, sessionId?: string): string {
    return path.join(this.logDirectory(sessionId), `${id}${LOG_EXTENSION}`);
  }

  rotatedLogPathFor(id: string, sessionId?: string): string {
    return `${this.logPathFor(id, sessionId)}${ROTATED_SUFFIX}`;
  }

  statePathFor(id: string, sessionId?: string): string {
    return path.join(this.stateDirectory(sessionId), `${id}${STATE_EXTENSION}`);
  }

  ensureDirectories(sessionId?: string): void {
    fs.mkdirSync(this.logDirectory(sessionId), { recursive: true });
    fs.mkdirSync(this.stateDirectory(sessionId), { recursive: true });
  }

  sweepHistory(ttlMs: number, now: number = Date.now()): LogSweepResult {
    const result: LogSweepResult = { removed: [], errors: [] };
    // A pinned log directory belongs to whoever pinned it, so that branch only
    // ever removes the files this package put there.
    if (process.env[LOG_DIR_ENV]?.trim()) {
      this.sweepStateDirectory(this.stateDirectory(), this.sessionId(), ttlMs, now, result);
      return result;
    }
    const root = this.storeDirectory();
    let sessions: string[];
    try {
      sessions = fs.readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === NOT_FOUND_ERROR_CODE) return result;
      result.errors.push(`Could not read runner history directory ${root}: ${String(error)}`);
      return result;
    }

    // Sweeping whole session directories rather than the three files a completed
    // record names is what keeps sockets, sidecars, runs that never reached a
    // terminal state, and the emptied directories themselves from accumulating.
    const active = this.currentSessionId();
    for (const sessionId of sessions) {
      if (sessionId === active) continue;
      this.sweepSessionDirectory(path.join(root, sessionId), ttlMs, now, result);
    }
    return result;
  }

  async sweepHistoryAsync(ttlMs: number, now: number = Date.now()): Promise<LogSweepResult> {
    const result: LogSweepResult = { removed: [], errors: [] };
    if (process.env[LOG_DIR_ENV]?.trim()) {
      await this.sweepStateDirectoryAsync(this.stateDirectory(), this.sessionId(), ttlMs, now, result);
      return result;
    }

    const root = this.storeDirectory();
    let sessions: string[];
    try {
      sessions = await fs.promises.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === NOT_FOUND_ERROR_CODE) return result;
      result.errors.push(`Could not read runner history directory ${root}: ${String(error)}`);
      return result;
    }

    const active = this.currentSessionId();
    for (const sessionId of sessions) {
      if (sessionId === active) continue;
      await this.sweepSessionDirectoryAsync(path.join(root, sessionId), ttlMs, now, result);
    }
    return result;
  }

  legacyDirectory(): string | undefined {
    const commonDirectory = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], process.cwd());
    return commonDirectory ? path.join(commonDirectory, STORE_DIR_NAME) : undefined;
  }

  removeLegacyStore(): string | undefined {
    const target = this.legacyDirectory();
    if (!target || path.basename(target) !== STORE_DIR_NAME || !fs.existsSync(target)) return undefined;
    fs.rmSync(target, { recursive: true, force: true });
    return target;
  }

  /** The live session, if one is known, so a sweep never deletes underneath itself. */
  private currentSessionId(): string | undefined {
    try {
      return this.sessionId();
    } catch {
      // A CLI invocation outside a session still sweeps; it just has nothing to spare.
      return undefined;
    }
  }

  /** Removes a session's whole directory once its newest entry is past the TTL. */
  private sweepSessionDirectory(directory: string, ttlMs: number, now: number, result: LogSweepResult): void {
    try {
      if (now - newestEntryTime(directory) <= ttlMs) return;
      // An idle session can go quiet for longer than the TTL, and deleting one
      // takes its lifeline socket with it, which would read to its own runners
      // as an owner that had died. Its records name the owner, so ask.
      if (ownerAlive(path.join(directory, STATE_DIR_NAME))) return;
      fs.rmSync(directory, { recursive: true, force: true });
      result.removed.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
        result.errors.push(`Could not sweep runner session ${directory}: ${String(error)}`);
      }
    }
  }

  private async sweepSessionDirectoryAsync(
    directory: string,
    ttlMs: number,
    now: number,
    result: LogSweepResult,
  ): Promise<void> {
    try {
      if (now - (await newestEntryTimeAsync(directory)) <= ttlMs) return;
      if (await ownerAliveAsync(path.join(directory, STATE_DIR_NAME))) return;
      await fs.promises.rm(directory, { recursive: true, force: true });
      result.removed.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
        result.errors.push(`Could not sweep runner session ${directory}: ${String(error)}`);
      }
    }
  }

  private sessionId(explicit?: string): string {
    const sessionId = explicit?.trim() || this.adoptedSessionId || inheritedSessionId();
    if (!sessionId) throw new Error('PI_SESSION_ID is required for doom-runner storage');
    return sessionId;
  }

  private storeDirectory(): string {
    const override = process.env[LOG_DIR_ENV]?.trim();
    if (override) return path.dirname(path.resolve(override));
    return path.join(resolveAgentDirectory(process.env), STORE_DIR_NAME);
  }

  private sessionDirectory(sessionId?: string): string {
    return path.join(this.storeDirectory(), this.sessionId(sessionId));
  }

  private sweepStateDirectory(
    directory: string,
    sessionId: string,
    ttlMs: number,
    now: number,
    result: LogSweepResult,
  ): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
        result.errors.push(`Could not read runner state directory ${directory}: ${String(error)}`);
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(STATE_EXTENSION)) continue;
      const statePath = path.join(directory, entry);
      try {
        const value: unknown = JSON.parse(fs.readFileSync(statePath, FILE_ENCODING));
        const finishedAt = completedAt(value);
        if (finishedAt === undefined || now - finishedAt <= ttlMs) continue;
        const id = entry.slice(0, -STATE_EXTENSION.length);
        this.removeHistoryFiles(sessionId, id, statePath, result);
      } catch (error) {
        result.errors.push(`Could not sweep runner metadata ${statePath}: ${String(error)}`);
      }
    }
  }

  private async sweepStateDirectoryAsync(
    directory: string,
    sessionId: string,
    ttlMs: number,
    now: number,
    result: LogSweepResult,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
        result.errors.push(`Could not read runner state directory ${directory}: ${String(error)}`);
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(STATE_EXTENSION)) continue;
      const statePath = path.join(directory, entry);
      try {
        const value: unknown = JSON.parse(await fs.promises.readFile(statePath, FILE_ENCODING));
        const finishedAt = completedAt(value);
        if (finishedAt === undefined || now - finishedAt <= ttlMs) continue;
        const id = entry.slice(0, -STATE_EXTENSION.length);
        await this.removeHistoryFilesAsync(sessionId, id, statePath, result);
      } catch (error) {
        result.errors.push(`Could not sweep runner metadata ${statePath}: ${String(error)}`);
      }
    }
  }

  private removeHistoryFiles(sessionId: string, id: string, statePath: string, result: LogSweepResult): void {
    const candidates = [statePath, this.logPathFor(id, sessionId), this.rotatedLogPathFor(id, sessionId)];
    for (const candidate of candidates) {
      try {
        fs.unlinkSync(candidate);
        result.removed.push(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
          result.errors.push(`Could not remove runner history ${candidate}: ${String(error)}`);
        }
      }
    }
  }

  private async removeHistoryFilesAsync(
    sessionId: string,
    id: string,
    statePath: string,
    result: LogSweepResult,
  ): Promise<void> {
    const candidates = [statePath, this.logPathFor(id, sessionId), this.rotatedLogPathFor(id, sessionId)];
    for (const candidate of candidates) {
      try {
        await fs.promises.unlink(candidate);
        result.removed.push(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== NOT_FOUND_ERROR_CODE) {
          result.errors.push(`Could not remove runner history ${candidate}: ${String(error)}`);
        }
      }
    }
  }
}
