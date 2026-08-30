import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readSyncRegistration: vi.fn() }));

vi.mock('@agimon-ai/doompi/services', () => ({ readSyncRegistration: mocks.readSyncRegistration }));

import { readDevPluginRoots } from '../../src/adapters/webPluginVite.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-vite-')));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('readDevPluginRoots', () => {
  it('prefers an explicit roots list without reading a registration', () => {
    expect(readDevPluginRoots({ DOOMPI_WEB_PLUGIN_ROOTS: ['/one', '/two'].join(path.delimiter) }, '/home')).toEqual([
      '/one',
      '/two',
    ]);
    expect(mocks.readSyncRegistration).not.toHaveBeenCalled();
  });

  it('returns no roots when no repository is selected', () => {
    expect(readDevPluginRoots({}, '/home')).toEqual([]);
  });

  it('reads roots beside the selected repository web bundle', () => {
    const generation = temporaryDirectory();
    const webDirectory = path.join(generation, 'web');
    fs.mkdirSync(webDirectory);
    fs.writeFileSync(path.join(generation, 'pluginRoots.json'), '["/synced-a", "/synced-b"]\n');
    mocks.readSyncRegistration.mockReturnValue({ webDirectory });

    expect(readDevPluginRoots({ DOOMPI_ROOT: '/repo' }, '/home')).toEqual(['/synced-a', '/synced-b']);
    expect(mocks.readSyncRegistration).toHaveBeenCalledWith('/repo', '/home');
  });

  it('fails closed for absent or invalid registrations', () => {
    mocks.readSyncRegistration.mockReturnValueOnce({ webDirectory: null });
    expect(readDevPluginRoots({ DOOMPI_ROOT: '/repo' }, '/home')).toEqual([]);

    mocks.readSyncRegistration.mockImplementationOnce(() => {
      throw new Error('invalid registration');
    });
    expect(readDevPluginRoots({ DOOMPI_ROOT: '/repo' }, '/home')).toEqual([]);
  });
});
