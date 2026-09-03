import { describe, expect, it } from 'vitest';
import { isExternalRuntimePackage } from '../../scripts/desktopRuntimePlugin.ts';
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
