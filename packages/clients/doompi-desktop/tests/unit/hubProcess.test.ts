import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nodeRuntimeExecutable } from '../../src/adapters/hubProcess.ts';

describe('the Electron Node runtime', () => {
  it('uses the background helper on macOS so sessions do not appear in the Dock', () => {
    const executable = '/Applications/DoomPi.app/Contents/MacOS/DoomPi';
    const exists = vi.fn(() => true);

    const result = nodeRuntimeExecutable(executable, 'darwin', exists);

    expect(result).toBe(
      path.join('/Applications/DoomPi.app/Contents/Frameworks', 'DoomPi Helper.app', 'Contents/MacOS/DoomPi Helper'),
    );
    expect(exists).toHaveBeenCalledWith(result);
  });

  it('falls back to the main executable when a macOS helper is unavailable', () => {
    const executable = '/Applications/DoomPi.app/Contents/MacOS/DoomPi';
    expect(nodeRuntimeExecutable(executable, 'darwin', () => false)).toBe(executable);
  });

  it('keeps the main executable on other platforms', () => {
    const executable = '/opt/doompi/doompi';
    expect(nodeRuntimeExecutable(executable, 'linux', () => true)).toBe(executable);
  });
});
