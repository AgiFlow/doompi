import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface AdapterModule {
  default?: unknown;
}

describe('doom-mcp standalone adapter', () => {
  it('exposes one standard Pi adapter and no alternate Doom entry', async () => {
    const standardAdapter = (await import('../src/exports/extensions/pi.ts')) as AdapterModule;
    const alternateEntry = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/exports/extensions/doom.ts',
    );

    expect(standardAdapter.default).toEqual(expect.any(Function));
    await expect(access(alternateEntry)).rejects.toThrow();
  });
});
