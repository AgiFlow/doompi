import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_DIR_ENV } from '../../src/exports/config';
import { RunnerPaths } from '../../src/adapters/RunnerPaths';

const HOUR_MS = 60 * 60 * 1000;

let directory: string;

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-paths-')));
  process.env[LOG_DIR_ENV] = path.join(directory, 'logs');
  process.env.PI_SESSION_ID = 'session-a';
});

afterEach(() => {
  delete process.env[LOG_DIR_ENV];
  delete process.env.PI_SESSION_ID;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('RunnerPaths', () => {
  it('derives paired log and state paths from the override', () => {
    const paths = new RunnerPaths();
    expect(paths.logPathFor('api')).toBe(path.join(directory, 'logs', 'api.log'));
    expect(paths.rotatedLogPathFor('api')).toBe(path.join(directory, 'logs', 'api.log.1'));
    expect(paths.statePathFor('api')).toBe(path.join(directory, 'runs', 'api.json'));
  });

  it('requires a session id without an override', () => {
    delete process.env[LOG_DIR_ENV];
    delete process.env.PI_SESSION_ID;
    expect(() => new RunnerPaths().logDirectory()).toThrow('PI_SESSION_ID is required');
  });

  it('sweeps completed metadata and paired logs after the TTL', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const statePath = paths.statePathFor('expired');
    const logPath = paths.logPathFor('expired');
    const rotatedPath = paths.rotatedLogPathFor('expired');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ state: 'completed', exit: { finishedAt: new Date(Date.now() - 3 * HOUR_MS).toISOString() } }),
    );
    fs.writeFileSync(logPath, 'line\n');
    fs.writeFileSync(rotatedPath, 'older\n');

    const result = paths.sweepHistory(HOUR_MS);

    expect(result.errors).toEqual([]);
    expect(new Set(result.removed)).toEqual(new Set([statePath, logPath, rotatedPath]));
  });

  it('sweeps completed metadata asynchronously without blocking startup', async () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const statePath = paths.statePathFor('expired-async');
    const logPath = paths.logPathFor('expired-async');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ state: 'completed', exit: { finishedAt: new Date(Date.now() - 3 * HOUR_MS).toISOString() } }),
    );
    fs.writeFileSync(logPath, 'line\n');

    const result = await paths.sweepHistoryAsync(HOUR_MS);

    expect(result.errors).toEqual([]);
    expect(new Set(result.removed)).toEqual(new Set([statePath, logPath]));
  });

  it('keeps running and fresh completed history', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    fs.writeFileSync(paths.statePathFor('running'), JSON.stringify({ state: 'running' }));
    fs.writeFileSync(
      paths.statePathFor('fresh'),
      JSON.stringify({ state: 'completed', exit: { finishedAt: new Date().toISOString() } }),
    );

    expect(paths.sweepHistory(HOUR_MS)).toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(paths.statePathFor('running'))).toBe(true);
    expect(fs.existsSync(paths.statePathFor('fresh'))).toBe(true);
  });

  it('asynchronously retains running and fresh metadata while ignoring non-metadata files', async () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const runningPath = paths.statePathFor('running-async');
    const freshPath = paths.statePathFor('fresh-async');
    const socketPath = path.join(paths.stateDirectory(), 'lifeline.sock');
    fs.writeFileSync(runningPath, JSON.stringify({ state: 'running' }));
    fs.writeFileSync(freshPath, JSON.stringify({ state: 'completed', exit: { finishedAt: new Date().toISOString() } }));
    fs.writeFileSync(socketPath, '');

    await expect(paths.sweepHistoryAsync(HOUR_MS)).resolves.toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(runningPath)).toBe(true);
    expect(fs.existsSync(freshPath)).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('reports malformed retained metadata without deleting it', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const statePath = paths.statePathFor('broken');
    fs.writeFileSync(statePath, '{');

    const result = paths.sweepHistory(HOUR_MS);

    expect(result.errors[0]).toContain(statePath);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('treats a missing override directory as empty history', () => {
    process.env[LOG_DIR_ENV] = path.join(directory, 'missing', 'logs');
    expect(new RunnerPaths().sweepHistory(HOUR_MS)).toEqual({ removed: [], errors: [] });
  });

  it('retains a completed record whose finish time cannot be parsed', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const statePath = paths.statePathFor('unparseable');
    fs.writeFileSync(statePath, JSON.stringify({ state: 'completed', exit: { finishedAt: 'whenever' } }));

    expect(paths.sweepHistory(HOUR_MS)).toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('retains metadata that is valid JSON but not a record', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const statePath = paths.statePathFor('scalar');
    fs.writeFileSync(statePath, '"just a string"');

    expect(paths.sweepHistory(HOUR_MS)).toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('ignores files in the state directory that are not metadata', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const socketPath = path.join(paths.stateDirectory(), 'lifeline.sock');
    fs.writeFileSync(socketPath, '');

    expect(paths.sweepHistory(HOUR_MS)).toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('sweeps a completed record whose paired logs were already removed', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories();
    const statePath = paths.statePathFor('logless');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ state: 'completed', exit: { finishedAt: new Date(Date.now() - 3 * HOUR_MS).toISOString() } }),
    );

    const result = paths.sweepHistory(HOUR_MS);

    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([statePath]);
  });
});
