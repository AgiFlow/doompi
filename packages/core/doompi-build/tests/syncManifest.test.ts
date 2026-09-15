import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanExtensions } from '../src/services/scan';
import { syncManifest } from '../src/services/syncManifest';

const created: string[] = [];

function packageWith(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-manifest-'));
  created.push(directory);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(directory, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return directory;
}

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('syncManifest', () => {
  it('preserves channels owned by an opaque frontend escape hatch', () => {
    const packageDir = packageWith({
      'src/extensions/workspaces/sessions/(frontend)/extra.ts': 'export default {};\n',
    });
    const manifest = syncManifest({
      packageDir,
      manifest: { doompiWeb: { channels: ['voice_audio', 'voice_state'] } },
      graph: scanExtensions({ packageDir }),
      targets: ['web'],
      pluginId: 'voice',
    });

    expect(manifest.doompiWeb).toMatchObject({ channels: ['voice_audio', 'voice_state'] });
  });

  it('converges routed channels when no opaque frontend hatch remains', () => {
    const packageDir = packageWith({
      'src/extensions/workspaces/sessions/(frontend)/channel/current-state.ts': 'export default {};\n',
    });
    const manifest = syncManifest({
      packageDir,
      manifest: { doompiWeb: { channels: ['obsolete'] } },
      graph: scanExtensions({ packageDir }),
      targets: ['web'],
      pluginId: 'demo',
    });

    expect(manifest.doompiWeb).toMatchObject({ channels: ['current_state'] });
  });
});
