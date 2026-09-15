import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RMUX } from '@rmux/sdk';
import { describe, expect, it, vi } from 'vitest';

import { resolveBundledRmuxBinary, RmuxBackend } from '../../src/services/rmuxBackend';
import type { RunHandle } from '../../src/types/launcher';
import { FakeRunnerPaths } from '../doubles';

function rmuxInstalled(): boolean {
  const binary = resolveBundledRmuxBinary();
  if (!binary) return false;
  try {
    execFileSync(binary, ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!rmuxInstalled())('RMUX output capture', () => {
  it('preserves the final pipeline output when the log reader starts after the shell exits', async () => {
    const root = fs.mkdtempSync('/tmp/doom-rmux-capture-');
    const backend = new RmuxBackend(new FakeRunnerPaths(root));
    const command = RMUX.prototype.cmd;
    // Delay only the reader process. The mux, shell, pipeline, and exit monitor
    // remain real, reproducing a log reader that starts late under load.
    const delayedReader = vi.spyOn(RMUX.prototype, 'cmd').mockImplementation(function (this: RMUX, ...args) {
      if (args[0] === 'pipe-pane' && typeof args[3] === 'string') args[3] = `sleep 0.5; ${args[3]}`;
      return command.apply(this, args);
    });
    let handle: RunHandle | undefined;
    try {
      handle = await backend.launch({
        id: 'capture',
        name: 'capture',
        cwd: root,
        sessionId: 'capture-test',
        interactive: false,
        command:
          "printf 'first\\nFINAL-RESULT\\n' | cat | sed 's/first/first/' | tail -n 1; printf done > shell.finished",
      });
      expect(handle).toBeDefined();
      await expect(handle?.completion()).resolves.toEqual({ code: 0, signal: null });
      expect(fs.existsSync(path.join(root, 'shell.finished'))).toBe(true);
      expect(fs.readFileSync(handle!.logPath, 'utf8')).toBe('FINAL-RESULT\n');
      expect(handle?.output()).toBe('FINAL-RESULT\n');
    } finally {
      if (handle) await handle.stop();
      delayedReader.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
