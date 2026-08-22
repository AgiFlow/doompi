import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSE_KEY_ENV,
  COLLAPSE_KEY_OFF,
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_MAX_WIDGET_LINES,
  DEFAULT_STORE_TTL_MS,
  getMaxWidgetLines,
  getStoreTtlMs,
  MAX_WIDGET_LINES_ENV,
  resolveCollapseKey,
  STORE_TTL_MS_ENV,
} from '../src/exports/config';
import {
  hasStorePathOverride,
  removeLegacyStoreDirectory,
  removeLegacyStoreDirectoryAsync,
  resolveLegacyStoreDirectory,
  resolveSessionKey,
  resolveStorePath,
  STORE_PATH_ENV,
  sweepStoreFiles,
  sweepStoreFilesAsync,
} from '../src/exports/store/paths';

const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

let directory: string;

function writeStore(storePath: string, content: string = '{}'): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, content);
}

beforeEach(() => {
  vi.clearAllMocks();
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-task-paths-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('resolveStorePath', () => {
  it('honours the environment override above everything else', () => {
    const override = path.join(directory, 'custom', 'store.json');

    expect(resolveStorePath(directory, { [STORE_PATH_ENV]: override }, 'session-a')).toBe(override);
    expect(hasStorePathOverride({ [STORE_PATH_ENV]: override })).toBe(true);
  });

  it('places the store under the Pi agent directory by root session', () => {
    const agentDirectory = path.join(directory, 'agent');

    expect(resolveStorePath(directory, { [AGENT_DIR_ENV]: agentDirectory }, 'session-a')).toBe(
      path.join(agentDirectory, 'doom-task', 'session-a', 'tasks.json'),
    );
  });

  it.each([
    ['~', os.homedir()],
    ['~/custom-agent', path.join(os.homedir(), 'custom-agent')],
    ['relative-agent', path.resolve('relative-agent')],
  ])('resolves Pi agent directory override %s', (configured, expectedRoot) => {
    expect(resolveStorePath(directory, { [AGENT_DIR_ENV]: configured }, 'session-a')).toBe(
      path.join(expectedRoot, 'doom-task', 'session-a', 'tasks.json'),
    );
  });

  it('defaults to the standard Pi agent directory', () => {
    expect(resolveStorePath(directory, {}, 'session-a')).toBe(
      path.join(os.homedir(), '.pi', 'agent', 'doom-task', 'session-a', 'tasks.json'),
    );
  });

  it('uses the same Pi store inside and outside a Git repository', () => {
    const agentDirectory = path.join(directory, 'agent');
    const env = { [AGENT_DIR_ENV]: agentDirectory };
    const outside = path.join(directory, 'outside');
    const repository = path.join(directory, 'repository');
    const nested = path.join(repository, 'packages', 'nested');
    fs.mkdirSync(outside);
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: repository, stdio: 'ignore' });

    expect(resolveStorePath(nested, env, 'session-a')).toBe(resolveStorePath(outside, env, 'session-a'));
    expect(resolveStorePath(nested, env, 'session-a')).not.toContain(path.join('.git', 'doom-task'));
  });

  it('gives one session tree the same file and isolates another session', () => {
    const env = { [AGENT_DIR_ENV]: path.join(directory, 'agent') };
    const nested = path.join(directory, 'packages', 'nested');
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveStorePath(nested, env, 'session-a')).toBe(resolveStorePath(directory, env, 'session-a'));
    expect(resolveStorePath(directory, env, 'session-a')).not.toBe(resolveStorePath(directory, env, 'session-b'));
  });

  it('derives child and root keys without extension ordering', () => {
    expect(resolveSessionKey('root', { [SUBAGENT_PARENT_SESSION_ENV]: 'stale' })).toBe('root');
    expect(resolveSessionKey('child', { [SUBAGENT_CHILD_ENV]: '1', [SUBAGENT_PARENT_SESSION_ENV]: 'root' })).toBe(
      'root',
    );
  });

  it('rejects a blank session id', () => {
    expect(() => resolveStorePath(directory, {}, '   ')).toThrow('cannot be blank');
  });
});

describe('legacy store cleanup', () => {
  it('removes only the complete legacy doom-task directory', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    const legacy = resolveLegacyStoreDirectory(directory)!;
    const adjacent = path.join(path.dirname(legacy), 'doom-task-keep');
    const current = resolveStorePath(directory, { [AGENT_DIR_ENV]: path.join(directory, 'agent') }, 'current');
    writeStore(path.join(legacy, 'nested', 'old.json'));
    writeStore(path.join(adjacent, 'keep.json'));

    const result = removeLegacyStoreDirectory(current, directory);

    expect(result).toEqual({ removed: [legacy], errors: [] });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(adjacent)).toBe(true);
  });

  it('removes the legacy directory asynchronously', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    const legacy = resolveLegacyStoreDirectory(directory)!;
    const current = resolveStorePath(directory, { [AGENT_DIR_ENV]: path.join(directory, 'agent') }, 'current');
    writeStore(path.join(legacy, 'old.json'));

    await expect(removeLegacyStoreDirectoryAsync(current, directory)).resolves.toEqual({
      removed: [legacy],
      errors: [],
    });
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('keeps the legacy directory when it contains the explicit override', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    const legacy = resolveLegacyStoreDirectory(directory)!;
    const override = path.join(legacy, 'custom.json');
    writeStore(override);

    expect(removeLegacyStoreDirectory(override, directory)).toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(override)).toBe(true);
  });

  it('does nothing outside a Git repository', () => {
    const current = resolveStorePath(directory, { [AGENT_DIR_ENV]: path.join(directory, 'agent') }, 'current');
    expect(removeLegacyStoreDirectory(current, directory)).toEqual({ removed: [], errors: [] });
  });

  it('reports a legacy directory removal failure', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    const legacy = resolveLegacyStoreDirectory(directory)!;
    const current = resolveStorePath(directory, { [AGENT_DIR_ENV]: path.join(directory, 'agent') }, 'current');
    writeStore(path.join(legacy, 'old.json'));
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('permission denied');
    });

    const result = removeLegacyStoreDirectory(current, directory);
    remove.mockRestore();

    expect(result.removed).toEqual([]);
    expect(result.errors[0]).toContain('permission denied');
    expect(fs.existsSync(legacy)).toBe(true);
  });
});

describe('store retention', () => {
  it('deletes expired sessions while preserving current, fresh, locked, corrupt, and unrelated entries', () => {
    const env = { [AGENT_DIR_ENV]: path.join(directory, 'agent') };
    const current = resolveStorePath(directory, env, 'current');
    const expired = resolveStorePath(directory, env, 'expired');
    const fresh = resolveStorePath(directory, env, 'fresh');
    const locked = resolveStorePath(directory, env, 'locked');
    const corrupt = resolveStorePath(directory, env, 'corrupt');
    const unrelated = path.join(path.dirname(path.dirname(current)), 'unrelated', 'note.txt');
    for (const file of [current, expired, fresh, locked]) writeStore(file);
    writeStore(corrupt, '{');
    writeStore(unrelated, 'keep');
    fs.writeFileSync(`${locked}.lock`, 'locked');
    const now = Date.now();
    const old = new Date(now - 2000);
    fs.utimesSync(expired, old, old);
    fs.utimesSync(locked, old, old);
    fs.utimesSync(corrupt, old, old);

    const result = sweepStoreFiles(current, 1000, now);

    expect(result.removed).toEqual([path.dirname(expired)]);
    expect(result.errors[0]).toContain(corrupt);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(locked)).toBe(true);
    expect(fs.existsSync(corrupt)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('sweeps expired stores asynchronously', async () => {
    const env = { [AGENT_DIR_ENV]: path.join(directory, 'agent') };
    const current = resolveStorePath(directory, env, 'current-async');
    const expired = resolveStorePath(directory, env, 'expired-async');
    writeStore(expired);
    const now = Date.now();
    const old = new Date(now - 2000);
    fs.utimesSync(expired, old, old);

    await expect(sweepStoreFilesAsync(current, 1000, now)).resolves.toEqual({
      removed: [path.dirname(expired)],
      errors: [],
    });
  });

  it('reports an unreadable entry and continues removing other expired stores', () => {
    const env = { [AGENT_DIR_ENV]: path.join(directory, 'agent') };
    const current = resolveStorePath(directory, env, 'current-error');
    const broken = resolveStorePath(directory, env, 'broken');
    const expired = resolveStorePath(directory, env, 'other-expired');
    for (const file of [broken, expired]) writeStore(file);
    const realStat = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation((target, options) => {
      if (target === broken) throw new Error('unreadable');
      return realStat(target, options as never);
    });

    const result = sweepStoreFiles(current, -1);

    expect(result.errors[0]).toContain('unreadable');
    expect(fs.existsSync(expired)).toBe(false);
  });

  it('returns an empty result when the store directory is absent', () => {
    const current = path.join(directory, 'missing', 'current', 'tasks.json');
    expect(sweepStoreFiles(current, 1000)).toEqual({
      removed: [],
      errors: [],
    });
  });

  it.each(['invalid', '-1', '0'])('falls back for invalid TTL %s', (value) => {
    expect(getStoreTtlMs({ [STORE_TTL_MS_ENV]: value })).toBe(DEFAULT_STORE_TTL_MS);
  });

  it('accepts a positive TTL override', () => {
    expect(getStoreTtlMs({ [STORE_TTL_MS_ENV]: '1234' })).toBe(1234);
  });

  it('rejects a child process without a root session id', () => {
    expect(() => resolveSessionKey('child', { [SUBAGENT_CHILD_ENV]: '1' })).toThrow(SUBAGENT_PARENT_SESSION_ENV);
  });
});

describe('task configuration', () => {
  it.each([
    [{}, DEFAULT_MAX_WIDGET_LINES],
    [{ [MAX_WIDGET_LINES_ENV]: 'invalid' }, DEFAULT_MAX_WIDGET_LINES],
    [{ [MAX_WIDGET_LINES_ENV]: '1' }, 3],
    [{ [MAX_WIDGET_LINES_ENV]: '100' }, 60],
    [{ [MAX_WIDGET_LINES_ENV]: '20' }, 20],
  ])('resolves widget line bounds', (env, expected) => {
    expect(getMaxWidgetLines(env)).toBe(expected);
  });

  it('resolves collapse shortcut defaults, overrides, and off sentinel', () => {
    expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ [COLLAPSE_KEY_ENV]: 'ctrl+x' })).toBe('ctrl+x');
    expect(resolveCollapseKey({ [COLLAPSE_KEY_ENV]: 'OFF' })).toBe(COLLAPSE_KEY_OFF);
  });
});
