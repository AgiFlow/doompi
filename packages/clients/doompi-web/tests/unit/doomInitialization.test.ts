import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureDoomInitialized } from '../../src/adapters/doomInitialization.ts';

describe('doompi-web initialization', () => {
  it('leaves an existing global Doom configuration untouched', async () => {
    const runInit = vi.fn(async () => {});

    const initialized = await ensureDoomInitialized({
      homeDirectory: '/home/tester',
      exists: () => true,
      runInit,
    });

    expect(initialized).toBe(false);
    expect(runInit).not.toHaveBeenCalled();
  });

  it('runs doompi init when the global configuration directory is absent', async () => {
    const runInit = vi.fn(async () => {});
    const notices: string[] = [];
    const exists = vi.fn(() => false);

    const initialized = await ensureDoomInitialized({
      homeDirectory: '/home/tester',
      exists,
      runInit,
      onNotice: (message) => notices.push(message),
    });

    expect(initialized).toBe(true);
    expect(exists).toHaveBeenCalledWith(path.join('/home/tester', '.pi', '.doom'));
    expect(runInit).toHaveBeenCalledOnce();
    expect(notices).toContainEqual(expect.stringContaining('running doompi init'));
  });
});
