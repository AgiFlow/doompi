import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TmuxBackend } from '../../src/adapters/TmuxBackend/TmuxBackend.ts';
import type { RunHandle } from '../../src/types/launcher';
import type { PtyRun } from '../../src/types/ptyHost';
import type { IRunnerPaths } from '../../src/services/RunnerPaths/types';
import type { ITmuxClient } from '../../src/types/tmuxClient';

const TEST_TIMEOUT_MS = 20_000;

function tmuxInstalled(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasTmux = tmuxInstalled();
let root = '';
let emitWarning: ReturnType<typeof vi.spyOn>;

function pathsFor(repository: string): IRunnerPaths {
  return {
    repositoryPath: () => repository,
    setSessionId: () => undefined,
    logDirectory: () => path.join(root, 'logs'),
    stateDirectory: () => path.join(root, 'state'),
    logPathFor: (id) => path.join(root, 'logs', `${id}.log`),
    rotatedLogPathFor: (id) => path.join(root, 'logs', `${id}.1.log`),
    statePathFor: (id) => path.join(root, 'state', `${id}.json`),
    ensureDirectories: () => {
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    },
    sweepHistory: () => ({ removed: [], errors: [] }),
    legacyDirectory: () => undefined,
    removeLegacyStore: () => undefined,
  };
}

const startedSockets = new Set<string>();

function socketFor(repository: string): string {
  return `doom-tmux-${createHash('sha256').update(repository).digest('hex').slice(0, 12)}`;
}

/** A distinct repository path per test gives each one its own tmux server. */
function backendFor(repository: string): TmuxBackend {
  startedSockets.add(socketFor(repository));
  return new TmuxBackend(pathsFor(repository));
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let previousTmuxTmpdir: string | undefined;
let socketRoot = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-tmux-'));
  // Sockets live in their own short directory, removed with the test. A unix
  // socket path is capped near 104 bytes, which the platform temp directory
  // alone can exhaust on macOS.
  socketRoot = fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'dtmux-'));
  previousTmuxTmpdir = process.env['TMUX_TMPDIR'];
  process.env['TMUX_TMPDIR'] = socketRoot;
  emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
});

afterEach(() => {
  emitWarning.mockRestore();
  for (const socket of startedSockets) {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // The last session ending already stopped the server, which is the
      // ordinary case rather than a cleanup failure.
    }
  }
  startedSockets.clear();
  if (previousTmuxTmpdir === undefined) delete process.env['TMUX_TMPDIR'];
  else process.env['TMUX_TMPDIR'] = previousTmuxTmpdir;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(socketRoot, { recursive: true, force: true });
});

describe.skipIf(!hasTmux)('TmuxBackend against a real tmux server', () => {
  it(
    'runs a command to completion and captures its output',
    async () => {
      const backend = backendFor(`${root}-complete`);

      const handle = await backend.launch({
        id: 'run-complete',
        name: 'complete',
        command: 'echo hello-from-tmux',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });

      expect(handle).toBeDefined();
      expect(handle?.backend).toBe('tmux');
      expect(handle?.backendTarget).toBe('doom-tmux-run-complete');
      expect(handle?.pid).toBeGreaterThan(0);

      await expect(handle?.completion()).resolves.toEqual({ code: 0, signal: null });
      // Log contents are not asserted here: the pane spawns the log sink from
      // source under vitest, and that entry is only spawnable once built.
      expect(fs.existsSync(path.join(root, 'logs', 'run-complete.log'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports the command exit code',
    async () => {
      const backend = backendFor(`${root}-exit`);

      const handle = await backend.launch({
        id: 'run-exit',
        name: 'exit',
        command: 'exit 7',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });

      await expect(handle?.completion()).resolves.toEqual({ code: 7, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'attaches the log pipe to the live pane',
    async () => {
      const repository = `${root}-pipe`;
      const backend = backendFor(repository);
      const handle = await backend.launch({
        id: 'run-pipe',
        name: 'pipe',
        command: 'sleep 30',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });
      if (!handle?.backendTarget || handle.pid === undefined) throw new Error('Expected a supervised tmux run');

      const piped = execFileSync(
        'tmux',
        ['-L', socketFor(repository), 'display-message', '-p', '-t', handle.backendTarget, '-F', '#{pane_pipe}'],
        { encoding: 'utf8' },
      ).trim();

      expect(piped).toBe('1');

      await backend.stop(handle.backendTarget, handle.pid);
      await handle.completion();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops a long-running command and settles its completion',
    async () => {
      const backend = backendFor(`${root}-stop`);
      const handle = await backend.launch({
        id: 'run-stop',
        name: 'stop',
        command: 'sleep 120',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });
      if (!handle?.backendTarget || handle.pid === undefined) throw new Error('Expected a supervised tmux run');

      await expect(backend.stop(handle.backendTarget, handle.pid)).resolves.toBe(true);
      // Either shape is a settled stop: the supervisor records the signal when it
      // outlives its pane, and the pane's own exit status stands in when it does not.
      const outcome = await handle.completion();
      expect(outcome.signal === 'SIGTERM' || typeof outcome.code === 'number').toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to stop a target it does not own or a mismatched pid',
    async () => {
      const backend = backendFor(`${root}-guard`);
      const handle = await backend.launch({
        id: 'run-guard',
        name: 'guard',
        command: 'sleep 120',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });
      if (!handle?.backendTarget || handle.pid === undefined) throw new Error('Expected a supervised tmux run');

      await expect(backend.stop('someone-elses-session', handle.pid)).resolves.toBe(false);
      await expect(backend.stop(handle.backendTarget, handle.pid + 10_000)).resolves.toBe(false);

      await backend.stop(handle.backendTarget, handle.pid);
      await handle.completion();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers input to an interactive pane and exposes its screen',
    async () => {
      const backend = backendFor(`${root}-input`);
      const handle = await backend.launch({
        id: 'run-input',
        name: 'input',
        command: 'cat',
        cwd: root,
        sessionId: 'session-1',
        interactive: true,
      });
      if (!handle?.backendTarget || handle.pid === undefined) throw new Error('Expected a supervised tmux run');

      const run = backend.get('input');
      expect(run).toBeDefined();

      await expect(backend.input(handle.backendTarget, 'typed-into-pane\n')).resolves.toBe(true);
      await waitUntil(() => (run?.screen() ?? '').includes('typed-into-pane'), 'the pane screen to echo input');

      await backend.stop(handle.backendTarget, handle.pid);
      await handle.completion();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('TmuxBackend without a usable tmux', () => {
  it('declines to launch so the caller can fall back', async () => {
    const failing: ITmuxClient = {
      run: () => Promise.reject(new Error('spawn tmux ENOENT')),
      format: () => Promise.resolve(undefined),
      sessionMissing: () => Promise.resolve(true),
    };
    const backend = new TmuxBackend(pathsFor('/repo'), () => failing);

    await expect(
      backend.launch({
        id: 'run-none',
        name: 'none',
        command: 'echo hi',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      }),
    ).resolves.toBeUndefined();
    await expect(backend.stop('doom-tmux-run-none', 123)).resolves.toBe(false);
    await expect(backend.input('doom-tmux-run-none', 'text')).resolves.toBe(false);
    await expect(backend.watch('run-none', 'doom-tmux-run-none')).resolves.toBeUndefined();
  });

  it('treats a non-zero tmux version probe as unusable', async () => {
    const refusing: ITmuxClient = {
      run: () => Promise.resolve({ returnCode: 1, stdout: '', stderr: 'not tmux' }),
      format: () => Promise.resolve(undefined),
      sessionMissing: () => Promise.resolve(true),
    };
    const backend = new TmuxBackend(pathsFor('/repo'), () => refusing);

    await expect(
      backend.launch({
        id: 'run-bad',
        name: 'bad',
        command: 'echo hi',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Drives the paths a machine without tmux never reaches.
 *
 * The suite above needs a real tmux server, so CI skips it and leaves the
 * failure handling untested. A scripted client covers the same code with no
 * binary present.
 */
describe('TmuxBackend failure handling with a scripted tmux', () => {
  interface Script {
    run?: (args: string[]) => Promise<{ returnCode: number; stdout: string; stderr: string }>;
    format?: (target: string, spec: string) => Promise<string | undefined>;
    sessionMissing?: (target: string) => Promise<boolean>;
  }

  function scripted(script: Script): ITmuxClient {
    return {
      run: script.run ?? (() => Promise.resolve({ returnCode: 0, stdout: '', stderr: '' })),
      format: script.format ?? (() => Promise.resolve(undefined)),
      sessionMissing: script.sessionMissing ?? (() => Promise.resolve(false)),
    };
  }

  function backendWith(script: Script): TmuxBackend {
    return new TmuxBackend(pathsFor('/scripted-repo'), () => scripted(script));
  }

  describe('a launch that tmux accepts', () => {
    /** Answers the pane queries a launch makes, then reports a clean exit. */
    function launching(exitStatus = '0'): Script {
      return {
        format: (_target, spec) =>
          Promise.resolve(spec === '#{pane_pid}' ? String(process.pid) : `1:${exitStatus}:doom-tmux-run-ok`),
      };
    }

    it('hands back a handle describing the pane it created', async () => {
      const backend = backendWith(launching());

      const handle = await backend.launch({
        id: 'run-ok',
        name: 'ok',
        command: 'echo hi',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });

      expect(handle?.backend).toBe('tmux');
      expect(handle?.backendTarget).toBe('doom-tmux-run-ok');
      expect(handle?.pid).toBe(process.pid);
      await expect(handle?.completion()).resolves.toMatchObject({ code: 0 });
    });

    it('reports the pane exit code it was given', async () => {
      const backend = backendWith(launching('3'));

      const handle = await backend.launch({
        id: 'run-ok',
        name: 'ok',
        command: 'exit 3',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });

      await expect(handle?.completion()).resolves.toMatchObject({ code: 3 });
    });

    it('stops buffering output once the caller detaches', async () => {
      const backend = backendWith(launching());

      const handle = await backend.launch({
        id: 'run-ok',
        name: 'ok',
        command: 'echo hi',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });
      handle?.detach();

      expect(handle?.output()).toBe('');
    });

    it('registers an interactive run under its name', async () => {
      const backend = backendWith(launching());

      await backend.launch({
        id: 'run-ok',
        name: 'ok',
        command: 'echo hi',
        cwd: root,
        sessionId: 'session-1',
        interactive: true,
      });

      expect(backend.get('ok')).toBeDefined();
    });

    it('gives up when tmux refuses to create the session', async () => {
      const backend = backendWith({
        run: (args) =>
          Promise.resolve(
            args[0] === 'new-session'
              ? { returnCode: 1, stdout: '', stderr: 'duplicate session' }
              : { returnCode: 0, stdout: '', stderr: '' },
          ),
      });

      await expect(
        backend.launch({
          id: 'run-dupe',
          name: 'dupe',
          command: 'echo hi',
          cwd: root,
          sessionId: 'session-1',
          interactive: false,
        }),
      ).resolves.toBeUndefined();
    });

    it('gives up when the pane never reports a pid', async () => {
      const backend = backendWith({ format: () => Promise.resolve(undefined) });

      await expect(
        backend.launch({
          id: 'run-nopid',
          name: 'nopid',
          command: 'echo hi',
          cwd: root,
          sessionId: 'session-1',
          interactive: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('an interactive run', () => {
    async function interactiveFor(screenText: string): Promise<PtyRun | undefined> {
      let frame = 0;
      const backend = new TmuxBackend(pathsFor('/scripted-repo'), () => ({
        // A pane that never changes never notifies, so each capture differs.
        run: (args) =>
          Promise.resolve(
            args[0] === 'capture-pane'
              ? { returnCode: 0, stdout: `${screenText} ${frame++}`, stderr: '' }
              : { returnCode: 0, stdout: '', stderr: '' },
          ),
        // Never dead, so the pane stays live for the duration of the test.
        format: (_target, spec) => Promise.resolve(spec === '#{pane_pid}' ? String(process.pid) : '0::doom-tmux-run-i'),
        sessionMissing: () => Promise.resolve(false),
      }));
      await backend.launch({
        id: 'run-i',
        name: 'interactive',
        command: 'bash',
        cwd: root,
        sessionId: 'session-1',
        interactive: true,
      });
      return backend.get('interactive');
    }

    it('publishes the captured screen to its subscribers', async () => {
      const run = await interactiveFor('hello from the pane');
      const seen: string[] = [];
      run?.onData((data) => seen.push(data));

      await waitUntil(() => seen.length > 0, 'screen data');

      expect(seen[0]).toMatch(/^hello from the pane \d+$/);
      expect(run?.screen()).toBe(seen.at(-1));
    });

    it('stops delivering to a subscriber that unsubscribed', async () => {
      const run = await interactiveFor('first');
      const seen: string[] = [];
      const unsubscribe = run?.onData((data) => seen.push(data));

      await waitUntil(() => seen.length > 0, 'first frame');
      unsubscribe?.();
      const countAfterUnsubscribe = seen.length;
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(seen.length).toBe(countAfterUnsubscribe);
    });

    it('accepts writes and resizes without throwing', async () => {
      const run = await interactiveFor('ready');

      expect(() => run?.write('ls\n')).not.toThrow();
      expect(() => run?.resize(120, 40)).not.toThrow();
    });
  });

  describe('stop', () => {
    it('refuses a target this backend does not own', async () => {
      const backend = backendWith({});

      await expect(backend.stop('someone-elses-session', 4321)).resolves.toBe(false);
    });

    it('refuses an implausible pid rather than signalling it', async () => {
      const backend = backendWith({});

      await expect(backend.stop('doom-tmux-run-a', 0)).resolves.toBe(false);
      await expect(backend.stop('doom-tmux-run-a', -1)).resolves.toBe(false);
      await expect(backend.stop('doom-tmux-run-a', 1.5)).resolves.toBe(false);
    });

    it('leaves a pane alone when its pid is not the one the caller expected', async () => {
      // The run died and the pid was reused, so stopping it would kill a stranger.
      const backend = backendWith({ format: () => Promise.resolve('999999') });

      await expect(backend.stop('doom-tmux-run-a', 4321)).resolves.toBe(false);
    });

    it('reports a pane whose pid tmux will not give up', async () => {
      const backend = backendWith({ format: () => Promise.resolve('not-a-pid') });

      await expect(backend.stop('doom-tmux-run-a', 4321)).resolves.toBe(false);
    });

    it('reports a tmux that fails outright', async () => {
      const backend = backendWith({ format: () => Promise.reject(new Error('server gone')) });

      await expect(backend.stop('doom-tmux-run-a', 4321)).resolves.toBe(false);
    });
  });

  describe('a pane whose process is already gone', () => {
    // A pid no longer in the table means the work finished; closing the
    // session is still the right outcome.
    it('closes the session anyway', async () => {
      const absentPid = 999_999;
      const backend = backendWith({ format: () => Promise.resolve(String(absentPid)) });

      await expect(backend.stop('doom-tmux-run-a', absentPid)).resolves.toBe(true);
    });
  });

  describe('buffered output', () => {
    async function launchFor(id: string): Promise<RunHandle | undefined> {
      const backend = backendWith({
        format: (_target, spec) =>
          Promise.resolve(spec === '#{pane_pid}' ? String(process.pid) : `1:0:doom-tmux-${id}`),
      });
      return backend.launch({
        id,
        name: id,
        command: 'echo hi',
        cwd: root,
        sessionId: 'session-1',
        interactive: false,
      });
    }

    it('answers nothing when the log has gone', async () => {
      const handle = await launchFor('run-nolog');
      fs.rmSync(path.join(root, 'logs', 'run-nolog.log'), { force: true });

      expect(handle?.output()).toBe('');
    });

    it('keeps the end of a log rather than the whole of it', async () => {
      const handle = await launchFor('run-biglog');
      const tailMarker = 'THE-VERY-END';
      fs.writeFileSync(path.join(root, 'logs', 'run-biglog.log'), `${'x'.repeat(2_000_000)}${tailMarker}`);

      const output = handle?.output() ?? '';

      expect(output.endsWith(tailMarker)).toBe(true);
      expect(output.length).toBeLessThan(2_000_000);
    });
  });

  describe('input', () => {
    it('reports a rejected send', async () => {
      const backend = backendWith({
        run: (args) =>
          args[0] === 'send-keys'
            ? Promise.reject(new Error('no server'))
            : Promise.resolve({ returnCode: 0, stdout: '', stderr: '' }),
      });

      await expect(backend.input('doom-tmux-run-a', 'hello')).resolves.toBe(false);
    });

    it('reports a non-zero send', async () => {
      const backend = backendWith({
        run: (args) =>
          Promise.resolve(
            args[0] === 'send-keys'
              ? { returnCode: 1, stdout: '', stderr: 'no such pane' }
              : { returnCode: 0, stdout: '', stderr: '' },
          ),
      });

      await expect(backend.input('doom-tmux-run-a', 'hello')).resolves.toBe(false);
    });

    it('confirms a send tmux accepted', async () => {
      const backend = backendWith({});

      await expect(backend.input('doom-tmux-run-a', 'hello')).resolves.toBe(true);
    });
  });

  describe('watch', () => {
    it('answers nothing for a session tmux does not have', async () => {
      const backend = backendWith({ sessionMissing: () => Promise.resolve(true) });

      await expect(backend.watch('run-a', 'doom-tmux-run-a')).resolves.toBeUndefined();
    });
  });

  describe('readOutcome', () => {
    it('answers nothing when the run left no exit record', async () => {
      expect(backendWith({}).readOutcome('run-never-ran', 'session-1')).toBeUndefined();
    });
  });

  describe('get', () => {
    it('answers nothing for a name it never launched', () => {
      expect(backendWith({}).get('absent')).toBeUndefined();
    });
  });
});
