import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledDoomPiPackages, isExternalRuntimePackage } from '../../scripts/desktopRuntimePlugin.ts';
import runtimeConfig from '../../vite.runtime.config.ts';

describe('desktop runtime externals', () => {
  it('keeps Pi imports on the staged package instance', () => {
    expect(isExternalRuntimePackage('@earendil-works/pi-coding-agent')).toBe(true);
    expect(isExternalRuntimePackage('@earendil-works/pi-coding-agent/client')).toBe(true);
  });

  it('continues bundling unrelated dependencies', () => {
    expect(isExternalRuntimePackage('@earendil-works/pi-server')).toBe(false);
  });
});

describe('desktop DoomPi entrypoints', () => {
  it('stages the entries needed to sync a repository', () => {
    expect(runtimeConfig).toMatchObject({
      build: {
        rollupOptions: {
          input: {
            'doompi/dist/src/extensions/entries/doom': expect.any(String),
            'doompi/dist/src/extensions/entries/styleSystem': expect.any(String),
          },
        },
      },
    });
  });
});

describe('desktop DoomPi package catalog', () => {
  it('includes selectable layer packages', () => {
    const workspaceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const names = bundledDoomPiPackages(workspaceRoot, `${process.platform}-${process.arch}`).map(
      (entry) => entry.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        '@agimon-ai/doompi-sandbox',
        '@agimon-ai/doompi-task',
        '@agimon-ai/doompi-team',
        '@agimon-ai/doompi-user-feedback',
      ]),
    );
  });
});
