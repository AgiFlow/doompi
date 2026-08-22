import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESULT_MAX_BYTES_ENV } from '../../src/exports/config';
import { runtimeEntry, supervisorPaths } from '../../src/schemas/runnerSpec';
import { Launcher } from '../../src/adapters/Launcher/Launcher';
import { FakeClock, FakeLogFile, FakeProcessControl, FakeRunnerPaths, FakeSpawner } from '../doubles.ts';

let previousMaxBytes: string | undefined;
let previousNoColor: string | undefined;
let previousPager: string | undefined;
let directory: string;

beforeEach(() => {
  previousMaxBytes = process.env[RESULT_MAX_BYTES_ENV];
  previousNoColor = process.env.NO_COLOR;
  previousPager = process.env.PAGER;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-launcher-')));
});

afterEach(() => {
  if (previousMaxBytes === undefined) delete process.env[RESULT_MAX_BYTES_ENV];
  else process.env[RESULT_MAX_BYTES_ENV] = previousMaxBytes;
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
  if (previousPager === undefined) delete process.env.PAGER;
  else process.env.PAGER = previousPager;
  fs.rmSync(directory, { recursive: true, force: true });
});

interface Harness {
  launcher: Launcher;
  spawner: FakeSpawner;
  logFile: FakeLogFile;
  control: FakeProcessControl;
  clock: FakeClock;
  paths: FakeRunnerPaths;
}

/** `null` spawns a process that never reported a pid. */
function harness(pid: number | null = 4242): Harness {
  const spawner = new FakeSpawner(pid ?? undefined);
  const control = new FakeProcessControl(new Set([4242]));
  const logFile = new FakeLogFile();
  const clock = new FakeClock();
  const paths = new FakeRunnerPaths(directory);
  return {
    launcher: new Launcher(spawner, control, logFile, clock, paths),
    spawner,
    logFile,
    control,
    clock,
    paths,
  };
}

/** The command itself now lives in the supervisor's spec rather than in the argv. */
function readSpec(paths: FakeRunnerPaths, id: string): { command: string; cwd: string } {
  return JSON.parse(fs.readFileSync(supervisorPaths(paths.stateDirectory(), id).spec, 'utf8')) as {
    command: string;
    cwd: string;
  };
}

const request = { id: 'api', name: 'api', command: 'sleep 1', cwd: '/repo', sessionId: 'session-a' };

describe('Launcher.launch', () => {
  it('inherits the host environment while forcing colour and disabling prompts', () => {
    process.env.NO_COLOR = '1';
    const { launcher, spawner, paths } = harness();
    launcher.launch(request);

    expect(spawner.last.request).toMatchObject({ cwd: '/repo', detached: true });
    expect(readSpec(paths, 'api').command).toBe('sleep 1');
    expect(spawner.last.request.env).toMatchObject({ FORCE_COLOR: '1', NO_COLOR: '1', CI: '1' });
  });

  // A supervised command has no keyboard, so a pager would wait at `(END)` until
  // the run timed out rather than returning any output at all.
  it('neutralises the pager it would otherwise inherit', () => {
    process.env.PAGER = 'less';
    const { launcher, spawner } = harness();
    launcher.launch(request);

    expect(spawner.last.request.env).toMatchObject({
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('runs the command under a supervisor that can outlive its owner', () => {
    const { launcher, spawner, paths } = harness();
    launcher.launch(request);

    const supervisor = supervisorPaths(paths.stateDirectory(), 'api');
    // exec replaces the shell, so the pid handed back leads the supervised group.
    expect(spawner.last.request.command).toContain('exec ');
    expect(spawner.last.request.command).toContain('runnerHost');
    expect(spawner.last.request.command).toContain(supervisor.spec);
    expect(runtimeEntry('runnerHost')).toContain(`${path.sep}bin${path.sep}runnerHost.ts`);
    expect(runtimeEntry('runnerHost')).not.toContain(`${path.sep}schemas${path.sep}bin${path.sep}`);
    // Nothing has to attach before a native run starts, so its gate opens at once.
    expect(fs.existsSync(supervisor.gate)).toBe(true);
  });

  it('resolves executable entries from the published module layout', () => {
    const builtModule = path.join(directory, 'dist', 'src', 'schemas', 'runnerSpec.mjs');
    const builtBin = path.join(directory, 'dist', 'bin');
    fs.mkdirSync(builtBin, { recursive: true });
    fs.writeFileSync(path.join(builtBin, 'runnerHost.mjs'), '');
    fs.writeFileSync(path.join(builtBin, 'logSink.mjs'), '');

    expect(runtimeEntry('runnerHost', pathToFileURL(builtModule).href)).toBe(path.join(builtBin, 'runnerHost.mjs'));
    expect(runtimeEntry('logSink', pathToFileURL(builtModule).href)).toBe(path.join(builtBin, 'logSink.mjs'));
  });

  it('reports the module it searched from when no executable entry ships beside it', () => {
    const orphanModule = path.join(directory, 'dist', 'src', 'schemas', 'runnerSpec.mjs');

    expect(() => runtimeEntry('runnerHost', pathToFileURL(orphanModule).href)).toThrow(
      /Cannot find bin\/runnerHost\.mjs by walking up from/,
    );
  });

  it('never holds the host process open', () => {
    const { launcher, spawner } = harness();
    launcher.launch(request);
    expect(spawner.last.unreffed).toBe(true);
  });

  it('tees output to both the buffer and the log from the first byte', () => {
    const { launcher, spawner, logFile } = harness();
    const handle = launcher.launch(request);

    spawner.last.emit('one\n');
    spawner.last.emit('two\n', 'stderr');

    expect(handle.output()).toBe('one\ntwo\n');
    expect(logFile.writes.get('/logs/api.log')).toBe('one\ntwo\n');
  });

  it('caps the in-memory buffer while the log keeps everything', () => {
    process.env[RESULT_MAX_BYTES_ENV] = '4';
    const { launcher, spawner, logFile } = harness();
    const handle = launcher.launch(request);

    spawner.last.emit('abcdefghij');

    expect(handle.output()).toBe('cdefghij');
    expect(logFile.writes.get('/logs/api.log')).toBe('abcdefghij');
  });

  it('resolves completion with the exit result and closes the log', async () => {
    const { launcher, spawner, logFile } = harness();
    const handle = launcher.launch(request);

    spawner.last.exit({ code: 3, signal: null });

    await expect(handle.completion()).resolves.toEqual({ code: 3, signal: null });
    expect(logFile.closed).toEqual(['/logs/api.log']);
  });

  it('rejects completion when the process never starts', async () => {
    const { launcher, spawner } = harness();
    const handle = launcher.launch(request);

    spawner.last.fail(new Error('spawn ENOENT'));

    await expect(handle.completion()).rejects.toThrow('spawn ENOENT');
  });

  it('ignores an exit that arrives after a start failure', async () => {
    const { launcher, spawner, logFile } = harness();
    const handle = launcher.launch(request);

    spawner.last.fail(new Error('spawn ENOENT'));
    spawner.last.exit();

    await expect(handle.completion()).rejects.toThrow('spawn ENOENT');
    expect(logFile.closed).toEqual(['/logs/api.log']);
  });

  it('stops buffering once detached but keeps writing to the log', () => {
    const { launcher, spawner, logFile } = harness();
    const handle = launcher.launch(request);

    spawner.last.emit('before\n');
    handle.detach();
    spawner.last.emit('after\n');

    expect(handle.output()).toBe('');
    expect(logFile.writes.get('/logs/api.log')).toBe('before\nafter\n');
  });

  it('reports the log path and pid it was given', () => {
    const { launcher } = harness();
    const handle = launcher.launch(request);
    expect(handle).toMatchObject({ name: 'api', pid: 4242, logPath: '/logs/api.log' });
  });

  it('cannot stop a process that never got a pid', async () => {
    const { launcher } = harness(null);
    await expect(launcher.launch(request).stop()).resolves.toBe(false);
  });

  it('stops through the handle when it has a pid', async () => {
    const { launcher, control } = harness();
    const handle = launcher.launch(request);
    control.die(4242);
    await expect(handle.stop()).resolves.toBe(false);
  });
});

describe('Launcher.stop', () => {
  it('reports nothing to do when the process is already gone', async () => {
    const { launcher, control } = harness();
    control.die(4242);
    await expect(launcher.stop(4242)).resolves.toBe(false);
  });

  it('signals the group and returns once the process goes away', async () => {
    const { launcher, control, clock } = harness();
    const stopped = launcher.stop(4242);

    expect(control.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    control.die(4242);
    await clock.advance(100);

    await expect(stopped).resolves.toBe(true);
    expect(control.signals.map((entry) => entry.signal)).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL when the grace period runs out', async () => {
    const { launcher, control, clock } = harness();
    const stopped = launcher.stop(4242);

    for (let elapsed = 0; elapsed < 2100; elapsed += 100) await clock.advance(100);

    await expect(stopped).resolves.toBe(true);
    expect(control.signals.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
