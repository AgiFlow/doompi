import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerPaths } from '../../src/adapters/RunnerPaths';
import { MAX_COMPLETED_RUNNERS_ENV } from '../../src/exports/config';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** A pid no live process can hold, so liveness checks read as "owner gone". */
const deadPid = 2 ** 30;

let agentDirectory: string;

/** Ages every entry in a session past any plausible TTL. */
function backdate(directory: string): void {
  const stale = new Date(Date.now() - 30 * ONE_DAY_MS);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(target)) fs.utimesSync(path.join(target, child), stale, stale);
    }
    fs.utimesSync(target, stale, stale);
  }
  fs.utimesSync(directory, stale, stale);
}

beforeEach(() => {
  agentDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-agent-')));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  delete process.env.DOOM_RUNNER_LOG_DIR;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env[MAX_COMPLETED_RUNNERS_ENV];
  fs.rmSync(agentDirectory, { recursive: true, force: true });
});

describe('RunnerPaths session scoping', () => {
  it('places logs under the Pi agent directory by session', () => {
    const paths = new RunnerPaths();
    paths.setSessionId('session-a');

    expect(paths.logDirectory()).toBe(path.join(agentDirectory, 'doom-runner', 'session-a', 'logs'));
    expect(paths.stateDirectory()).toBe(path.join(agentDirectory, 'doom-runner', 'session-a', 'runs'));
    expect(paths.logDirectory('session-b')).toBe(path.join(agentDirectory, 'doom-runner', 'session-b', 'logs'));
  });

  it('reports the worktree root as the registry scope', () => {
    const repositoryPath = new RunnerPaths().repositoryPath();
    expect(path.isAbsolute(repositoryPath)).toBe(true);
    expect(repositoryPath.endsWith(path.sep)).toBe(false);
  });

  it('keeps sibling session paths isolated', () => {
    const paths = new RunnerPaths();
    expect(paths.logPathFor('api', 'session-a')).not.toBe(paths.logPathFor('api', 'session-b'));
  });

  it('sweeps expired sessions whole, sockets and unfinished records included', () => {
    const paths = new RunnerPaths();
    for (const sessionId of ['session-a', 'session-b']) {
      paths.ensureDirectories(sessionId);
      // A run that never reached a terminal state used to be swept by nothing.
      fs.writeFileSync(paths.statePathFor('api', sessionId), JSON.stringify({ state: 'running', hostPid: deadPid }));
      fs.writeFileSync(paths.logPathFor('api', sessionId), 'done\n');
      fs.writeFileSync(path.join(paths.stateDirectory(sessionId), 'lifeline.sock'), '');
      backdate(path.join(agentDirectory, 'doom-runner', sessionId));
    }

    const result = paths.sweepHistory(ONE_DAY_MS);

    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([
      path.join(agentDirectory, 'doom-runner', 'session-a'),
      path.join(agentDirectory, 'doom-runner', 'session-b'),
    ]);
    expect(fs.existsSync(path.join(agentDirectory, 'doom-runner', 'session-a'))).toBe(false);
  });

  it('sweeps expired session directories asynchronously', async () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-a');
    fs.writeFileSync(paths.statePathFor('api', 'session-a'), JSON.stringify({ state: 'running', hostPid: deadPid }));
    const sessionDirectory = path.join(agentDirectory, 'doom-runner', 'session-a');
    backdate(sessionDirectory);

    const result = await paths.sweepHistoryAsync(ONE_DAY_MS);

    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([sessionDirectory]);
  });

  it('keeps an expired session whose owner is still running', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-a');
    fs.writeFileSync(
      paths.statePathFor('api', 'session-a'),
      JSON.stringify({ state: 'running', hostPid: process.pid }),
    );
    backdate(path.join(agentDirectory, 'doom-runner', 'session-a'));

    const result = paths.sweepHistory(ONE_DAY_MS);

    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(agentDirectory, 'doom-runner', 'session-a'))).toBe(true);
  });

  it('asynchronously retains fresh sessions and expired sessions with a live owner', async () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-fresh');
    const freshDirectory = path.join(agentDirectory, 'doom-runner', 'session-fresh');
    backdate(freshDirectory);
    fs.writeFileSync(path.join(freshDirectory, 'lifeline.sock'), '');

    paths.ensureDirectories('session-live');
    const liveDirectory = path.join(agentDirectory, 'doom-runner', 'session-live');
    fs.writeFileSync(
      paths.statePathFor('api', 'session-live'),
      JSON.stringify({ state: 'running', hostPid: process.pid }),
    );
    backdate(liveDirectory);

    const result = await paths.sweepHistoryAsync(ONE_DAY_MS);

    expect(result).toEqual({ removed: [], errors: [] });
    expect(fs.existsSync(freshDirectory)).toBe(true);
    expect(fs.existsSync(liveDirectory)).toBe(true);
  });

  it('rejects a blank adopted session id', () => {
    expect(() => new RunnerPaths().setSessionId('  ')).toThrow('cannot be blank');
  });

  it('expands a bare home alias in the agent directory', () => {
    process.env.PI_CODING_AGENT_DIR = '~';
    const paths = new RunnerPaths();
    paths.setSessionId('session-a');

    expect(paths.logDirectory()).toBe(path.join(os.homedir(), 'doom-runner', 'session-a', 'logs'));
  });

  it('expands a home-relative agent directory', () => {
    process.env.PI_CODING_AGENT_DIR = `~/${path.basename(agentDirectory)}`;
    const paths = new RunnerPaths();
    paths.setSessionId('session-a');

    expect(paths.logDirectory()).toBe(
      path.join(os.homedir(), path.basename(agentDirectory), 'doom-runner', 'session-a', 'logs'),
    );
  });

  it('sweeps an expired session whose records name no owner pid', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-a');
    // A record without a usable hostPid claims nothing, so the TTL decides alone.
    fs.writeFileSync(
      paths.statePathFor('api', 'session-a'),
      JSON.stringify({ state: 'running', hostPid: 'not-a-pid' }),
    );
    backdate(path.join(agentDirectory, 'doom-runner', 'session-a'));

    const result = paths.sweepHistory(ONE_DAY_MS);

    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([path.join(agentDirectory, 'doom-runner', 'session-a')]);
  });

  it('ages a session by loose files sitting beside its directories', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-a');
    const sessionDirectory = path.join(agentDirectory, 'doom-runner', 'session-a');
    fs.writeFileSync(path.join(sessionDirectory, 'lifeline.sock'), '');
    backdate(sessionDirectory);

    expect(paths.sweepHistory(ONE_DAY_MS).removed).toEqual([sessionDirectory]);

    // The same loose file kept current holds the whole session back.
    paths.ensureDirectories('session-b');
    const freshDirectory = path.join(agentDirectory, 'doom-runner', 'session-b');
    backdate(freshDirectory);
    fs.writeFileSync(path.join(freshDirectory, 'lifeline.sock'), '');

    expect(paths.sweepHistory(ONE_DAY_MS).removed).toEqual([]);
  });

  it('reports no legacy store when the worktree has none', () => {
    expect(new RunnerPaths().removeLegacyStore()).toBeUndefined();
  });

  it('sweeps the live session record by record, keeping its running runners and its directory', () => {
    const paths = new RunnerPaths();
    paths.setSessionId('session-a');
    paths.ensureDirectories();
    const sessionDirectory = path.join(agentDirectory, 'doom-runner', 'session-a');
    const socketPath = path.join(paths.stateDirectory(), 'lifeline.sock');
    fs.writeFileSync(socketPath, '');
    const donePath = paths.statePathFor('done');
    const doneLog = paths.logPathFor('done');
    fs.writeFileSync(
      donePath,
      JSON.stringify({
        state: 'completed',
        hostPid: process.pid,
        exit: { finishedAt: new Date(Date.now() - 3 * ONE_DAY_MS).toISOString() },
      }),
    );
    fs.writeFileSync(doneLog, 'output\n');
    const runningPath = paths.statePathFor('busy');
    fs.writeFileSync(runningPath, JSON.stringify({ state: 'running', hostPid: process.pid }));
    fs.writeFileSync(paths.logPathFor('busy'), 'still going\n');
    backdate(sessionDirectory);

    const result = paths.sweepHistory(ONE_DAY_MS);

    expect(result.errors).toEqual([]);
    expect(new Set(result.removed)).toEqual(new Set([donePath, doneLog]));
    // Nothing the live session still needs is touched.
    expect(fs.existsSync(sessionDirectory)).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(fs.existsSync(runningPath)).toBe(true);
    expect(fs.existsSync(paths.logPathFor('busy'))).toBe(true);
  });

  it('asynchronously sweeps the live session without removing it', async () => {
    const paths = new RunnerPaths();
    paths.setSessionId('session-a');
    paths.ensureDirectories();
    const donePath = paths.statePathFor('done');
    fs.writeFileSync(
      donePath,
      JSON.stringify({
        state: 'completed',
        exit: { finishedAt: new Date(Date.now() - 3 * ONE_DAY_MS).toISOString() },
      }),
    );
    backdate(path.join(agentDirectory, 'doom-runner', 'session-a'));

    const result = await paths.sweepHistoryAsync(ONE_DAY_MS);

    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([donePath]);
    expect(fs.existsSync(path.join(agentDirectory, 'doom-runner', 'session-a'))).toBe(true);
  });

  it('bounds the live session by completed count long before the TTL could', () => {
    process.env[MAX_COMPLETED_RUNNERS_ENV] = '3';
    const paths = new RunnerPaths();
    paths.setSessionId('session-a');
    paths.ensureDirectories();
    // All finished seconds ago, so age alone would keep every one of them.
    for (let index = 0; index < 10; index += 1) {
      fs.writeFileSync(
        paths.statePathFor(`done-${index}`),
        JSON.stringify({
          state: 'completed',
          exit: { finishedAt: new Date(Date.now() - index * 1000).toISOString() },
        }),
      );
    }
    fs.writeFileSync(paths.statePathFor('busy'), JSON.stringify({ state: 'running' }));

    const result = paths.sweepHistory(ONE_DAY_MS);

    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([3, 4, 5, 6, 7, 8, 9].map((index) => paths.statePathFor(`done-${index}`)));
    expect(fs.existsSync(paths.statePathFor('done-0'))).toBe(true);
    expect(fs.existsSync(paths.statePathFor('done-2'))).toBe(true);
    expect(fs.existsSync(paths.statePathFor('busy'))).toBe(true);
  });

  it('reclaims an orphaned empty session directory the TTL would still be holding', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-orphan');
    const orphan = path.join(agentDirectory, 'doom-runner', 'session-orphan');
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(path.join(orphan, 'logs'), stale, stale);
    fs.utimesSync(path.join(orphan, 'runs'), stale, stale);
    fs.utimesSync(orphan, stale, stale);

    // Half an hour old is nowhere near the day-long TTL, but there is nothing here.
    expect(paths.sweepHistory(ONE_DAY_MS).removed).toEqual([orphan]);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('leaves a just-created empty session alone', () => {
    const paths = new RunnerPaths();
    paths.ensureDirectories('session-new');
    const fresh = path.join(agentDirectory, 'doom-runner', 'session-new');

    expect(paths.sweepHistory(ONE_DAY_MS).removed).toEqual([]);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
