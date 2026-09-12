import { expect, it } from 'vitest';
import { readPackageResource } from '../../src/services/packageResources';

it('resolves the profile authoring skill from source and compiled module locations', async () => {
  const skill = 'src/prompts/doompi-author-profile/SKILL.md';
  const source = new URL('../../src/extensions/server.ts', import.meta.url);
  const compiled = new URL('../../dist/services/packageResources/index.mjs', import.meta.url);
  const content = await readPackageResource(skill, source);
  expect(content).toContain('doompi-author-profile');
  await expect(readPackageResource(skill, compiled)).resolves.toBe(content);
  await expect(readPackageResource('missing.md', source)).resolves.toBe('(resource unavailable)');
});
