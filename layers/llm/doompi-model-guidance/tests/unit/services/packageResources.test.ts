import { describe, expect, it } from 'vitest';
import { readPackageResource } from '../../../src/services/packageResources';

describe('shipped model guidance resources', () => {
  it('finds the same skill from source and nested compiled module locations', async () => {
    const source = new URL('../../../src/extensions/server.ts', import.meta.url);
    const compiled = new URL('../../../dist/services/packageResources/index.mjs', import.meta.url);
    const file = 'src/prompts/doompi-use-model-guidance/SKILL.md';
    const content = await readPackageResource(file, source);
    expect(content).toContain('doompi-use-model-guidance');
    await expect(readPackageResource(file, compiled)).resolves.toBe(content);
  });

  it('keeps missing optional resources non-fatal', async () => {
    await expect(readPackageResource('missing-resource.md')).resolves.toBe(
      '(resource unavailable: missing-resource.md)',
    );
  });
});
