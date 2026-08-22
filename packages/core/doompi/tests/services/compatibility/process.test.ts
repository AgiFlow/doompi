import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDirectoryLock,
  forwardSignals,
  isFileSystemError,
  lockOwnerIsRunning,
  pathInside,
  runCaptured,
  runChecked,
  runInteractive,
  signalExitCode,
  waitForExit,
} from '../../../src/exports/services/compatibility/process';

const NODE = process.execPath;
const SIGINT: NodeJS.Signals = 'SIGINT';
/** The terminal signals forwardSignals attaches to, in its own order. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

type SignalListener = (signal: NodeJS.Signals) => void;

/**
 * Returns the forwarder that `forwardSignals` just registered.
 *
 * The forwarder is invoked directly rather than through `process.emit`, because
 * emitting a terminal signal on this process also runs the test runner's own
 * handler and takes the worker down with it.
 */
function addedListener(before: readonly unknown[]): SignalListener {
  const added = process.listeners(SIGINT).filter((listener) => !before.includes(listener));
  expect(added).toHaveLength(1);
  return added[0] as SignalListener;
}

describe('compatibility process helpers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-process-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('runCaptured', () => {
    it('returns trimmed stdout for a successful command', () => {
      expect(runCaptured(NODE, ['-e', 'process.stdout.write("  value  ")'], root, process.env)).toBe('value');
    });

    it('forwards child stderr to the harness stderr', () => {
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      runCaptured(NODE, ['-e', 'process.stderr.write("a warning")'], root, process.env);

      expect(write).toHaveBeenCalledWith('a warning');
    });

    it('throws with the exit status for a failing command', () => {
      expect(() => runCaptured(NODE, ['-e', 'process.exit(3)'], root, process.env)).toThrow('exited with status 3');
    });

    it('throws the spawn error when the command does not exist', () => {
      expect(() => runCaptured(path.join(root, 'missing-binary'), [], root, process.env)).toThrow();
    });
  });

  describe('runChecked', () => {
    it('returns for a successful command', () => {
      expect(() => runChecked(NODE, ['-e', ''], root, process.env)).not.toThrow();
    });

    it('throws with the exit status for a failing command', () => {
      expect(() => runChecked(NODE, ['-e', 'process.exit(4)'], root, process.env)).toThrow('exited with status 4');
    });

    it('throws the spawn error when the command does not exist', () => {
      expect(() => runChecked(path.join(root, 'missing-binary'), [], root, process.env)).toThrow();
    });
  });

  describe('signalExitCode', () => {
    it.each([
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGQUIT', 131],
      ['SIGTERM', 143],
    ])('maps %s to %i', (signal, code) => {
      expect(signalExitCode(signal as NodeJS.Signals)).toBe(code);
    });

    it('falls back for no signal and for a signal the platform does not number', () => {
      expect(signalExitCode(null)).toBe(1);
      expect(signalExitCode('NOT_A_SIGNAL' as NodeJS.Signals)).toBe(1);
    });
  });

  describe('pathInside', () => {
    it.each([
      ['/repo', '/repo', true],
      ['/repo', '/repo/plugins', true],
      ['/repo', '/repo/plugins/shared', true],
      ['/repo', '/other', false],
      ['/repo', '/repo/..', false],
      ['/repo', '/', false],
    ])('reports %s containing %s as %s', (parent, candidate, expected) => {
      expect(pathInside(parent, candidate)).toBe(expected);
    });
  });

  describe('isFileSystemError', () => {
    it('recognises only errors carrying a string code', () => {
      const withCode = Object.assign(new Error('boom'), { code: 'ENOENT' });

      expect(isFileSystemError(withCode)).toBe(true);
      expect(isFileSystemError(new Error('boom'))).toBe(false);
      expect(isFileSystemError('ENOENT')).toBe(false);
      expect(isFileSystemError(undefined)).toBe(false);
    });
  });

  describe('lockOwnerIsRunning', () => {
    it('treats a lock with no owner file as unowned', () => {
      fs.mkdirSync(path.join(root, 'lock'));

      expect(lockOwnerIsRunning(path.join(root, 'lock'))).toBe(false);
    });

    it.each([{ pid: 'nine' }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, {}])(
      'treats an unusable owner pid as unowned: %j',
      (owner) => {
        const lockPath = path.join(root, 'lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner));

        expect(lockOwnerIsRunning(lockPath)).toBe(false);
      },
    );

    it('reports the current process as a live owner', () => {
      const lockPath = path.join(root, 'lock');
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));

      expect(lockOwnerIsRunning(lockPath)).toBe(true);
    });

    it('reports a dead owner as not running', () => {
      const lockPath = path.join(root, 'lock');
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });

      expect(lockOwnerIsRunning(lockPath)).toBe(false);
    });

    it('treats a pid owned by another user as still holding the lock', () => {
      const lockPath = path.join(root, 'lock');
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });

      expect(lockOwnerIsRunning(lockPath)).toBe(true);
    });
  });

  describe('acquireDirectoryLock', () => {
    it('creates the lock, records the owner, and removes it on release', async () => {
      const lockPath = path.join(root, 'nested', 'sync.lock');

      const release = await acquireDirectoryLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))).toEqual({ pid: process.pid });

      await release();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('reclaims a stale lock whose owner is gone', async () => {
      const lockPath = path.join(root, 'sync.lock');
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
      // Backdate past the stale window and make the recorded owner look dead.
      const stale = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, stale, stale);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });

      const release = await acquireDirectoryLock(lockPath);
      expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))).toEqual({ pid: process.pid });

      await release();
    });

    it('retries immediately when the holder releases between mkdir and stat', async () => {
      const lockPath = path.join(root, 'sync.lock');
      fs.mkdirSync(lockPath);
      vi.spyOn(fs.promises, 'stat').mockImplementationOnce(async () => {
        // Simulate the holder releasing after our mkdir lost the race.
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      });

      const release = await acquireDirectoryLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      await release();
    });

    it('cleans up and rethrows when the owner file cannot be written', async () => {
      const lockPath = path.join(root, 'sync.lock');
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      await expect(acquireDirectoryLock(lockPath)).rejects.toThrow('disk full');
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('propagates a lock error that is not a collision', async () => {
      vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(Object.assign(new Error('read only'), { code: 'EROFS' }));

      await expect(acquireDirectoryLock(path.join(root, 'sync.lock'))).rejects.toThrow('read only');
    });

    it('propagates a stat error that is not a missing lock', async () => {
      const lockPath = path.join(root, 'sync.lock');
      fs.mkdirSync(lockPath);
      vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('io error'), { code: 'EIO' }));

      await expect(acquireDirectoryLock(lockPath)).rejects.toThrow('io error');
    });
  });

  describe('child lifecycle', () => {
    it('resolves with the child exit code', async () => {
      const child = spawn(NODE, ['-e', 'process.exit(7)'], { stdio: 'ignore' });

      await expect(waitForExit(child)).resolves.toBe(7);
    });

    it('resolves with the conventional code when the child is signalled', async () => {
      const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
      const exit = waitForExit(child);
      child.kill('SIGTERM');

      await expect(exit).resolves.toBe(143);
    });

    it('rejects when the child cannot be spawned', async () => {
      const child = spawn(path.join(root, 'missing-binary'), [], { stdio: 'ignore' });

      await expect(waitForExit(child)).rejects.toThrow();
    });

    it('forwards signals while attached and stops once disposed', async () => {
      const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
      const kill = vi.spyOn(child, 'kill');
      const before = process.listeners(SIGINT);
      const stopForwarding = forwardSignals(child);
      const forward = addedListener(before);

      forward(SIGINT);
      expect(kill).toHaveBeenCalledWith(SIGINT);

      stopForwarding();
      expect(process.listeners(SIGINT)).not.toContain(forward);

      kill.mockRestore();
      child.kill('SIGKILL');
      await waitForExit(child);
    });

    it('registers and removes one forwarder for every terminal signal', () => {
      const child = spawn(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
      const counts = FORWARDED_SIGNALS.map((signal) => process.listeners(signal).length);

      const stopForwarding = forwardSignals(child);

      FORWARDED_SIGNALS.forEach((signal, index) => {
        expect(process.listeners(signal).length, signal).toBe(counts[index] + 1);
      });

      stopForwarding();

      FORWARDED_SIGNALS.forEach((signal, index) => {
        expect(process.listeners(signal).length, signal).toBe(counts[index]);
      });
      child.kill('SIGKILL');
    });

    it('does not signal a child that has already exited', async () => {
      const child = spawn(NODE, ['-e', ''], { stdio: 'ignore' });
      const before = process.listeners(SIGINT);
      const stopForwarding = forwardSignals(child);
      const forward = addedListener(before);
      await waitForExit(child);
      const kill = vi.spyOn(child, 'kill');

      forward(SIGINT);

      expect(kill).not.toHaveBeenCalled();
      stopForwarding();
    });

    it('runs a child to completion and returns its code', async () => {
      await expect(runInteractive(NODE, ['-e', 'process.exit(5)'], root, process.env)).resolves.toBe(5);
    });
  });
});
