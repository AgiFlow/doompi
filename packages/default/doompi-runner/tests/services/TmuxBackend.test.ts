import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TmuxBackend } from '../../src/adapters/TmuxBackend/TmuxBackend.ts';
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
