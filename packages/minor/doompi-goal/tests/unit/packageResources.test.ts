import { expect, it } from 'vitest';

import { readPackageResource } from '../../src/services/packageResources';
it('resolves the Goal skill from source and compiled paths and preserves read errors', async () => {
  const name = 'src/prompts/doompi-use-goal/SKILL.md';
  const source = new URL('../../src/extensions/server.ts', import.meta.url);
  const compiled = new URL('../../dist/services/packageResources/index.mjs', import.meta.url);
  const content = await readPackageResource(name, source);
  expect(content).toContain('doompi-use-goal');
  await expect(readPackageResource(name, compiled)).resolves.toBe(content);
  await expect(readPackageResource('missing.md', source)).rejects.toMatchObject({ code: 'ENOENT' });
});
