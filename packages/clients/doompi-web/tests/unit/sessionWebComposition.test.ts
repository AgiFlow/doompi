import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readSyncRegistration: vi.fn() }));

vi.mock('@agimon-ai/doompi/services', () => ({ readSyncRegistration: mocks.readSyncRegistration }));

import { resolveSessionWebArtifacts } from '../../src/adapters/sessionWebComposition.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('session web composition artifacts', () => {
  it('includes standalone CSS manifest entries not attached to the JavaScript entry', () => {
    const generation = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-web-composition-'));
    temporaryDirectories.push(generation);
    const webDirectory = path.join(generation, 'web');
    const pluginsDirectory = path.join(generation, 'plugins');
    fs.mkdirSync(webDirectory);
    fs.mkdirSync(path.join(pluginsDirectory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDirectory, 'composition.js'), 'globalThis.DoomPiWebPluginComposition = [];');
    fs.writeFileSync(
      path.join(pluginsDirectory, 'manifest.json'),
      JSON.stringify({
        'composition.ts': { file: 'composition.js', isEntry: true },
        'style.css': { file: 'assets/composition.css', src: 'style.css' },
      }),
    );
    mocks.readSyncRegistration.mockReturnValue({
      root: '/repo',
      generation: 'generation-one',
      stateSha256: 'state-one',
      webDirectory,
    });

    expect(resolveSessionWebArtifacts('/repo')).toEqual(
      expect.objectContaining({
        pluginsDir: pluginsDirectory,
        entryPath: '/composition.js',
        stylePaths: ['/assets/composition.css'],
      }),
    );
  });
});
