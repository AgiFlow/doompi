import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(packageDirectory, relativePath), 'utf8').catch(() => '');
}

describe('doom file edit extension boundaries', () => {
  it('folds typed host integration into the only standard Pi factory', async () => {
    const piEntry = await readSource('src/exports/extensions/pi.ts');
    const implementation = await readSource('src/adapters/pi/extension.ts');
    const alternateDoomEntry = await readSource('src/exports/extensions/doom.ts');

    expect(piEntry).toContain('fileEditExtension as default');
    expect(implementation).not.toMatch(/@agimon-ai\/doompi-team|@agimon-ai\/doompi-config/u);
    expect(implementation).toMatch(/DOOM_UI_HUB_SERVICE/u);
    expect(implementation).toMatch(/registerLeader/u);
    expect(implementation).not.toMatch(/['"]\.doom['"]/u);
    expect(alternateDoomEntry).toBe('');
  });

  it('keeps child session environment ownership in extension contracts', async () => {
    const paths = await readSource('src/adapters/FileEditPaths/FileEditPaths.ts');

    expect(paths).toMatch(/@agimon-ai\/doompi-extension-contracts\/child-process/u);
    expect(paths).not.toMatch(/@agimon-ai\/doompi-team\/env/u);
  });

  it('keeps the Pi adapter thin and delegates runtime behavior', async () => {
    const piEntry = await readSource('src/exports/extensions/pi.ts');

    expect(piEntry).not.toMatch(/registerCommand|session_start|tool_execution/u);
    expect(piEntry).toMatch(/default/u);
  });
});
