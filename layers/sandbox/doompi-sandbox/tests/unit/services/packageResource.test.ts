import { describe, expect, it } from 'vitest';
import { readPackageResource } from '../../../src/services/packageResource';

describe('published sandbox resources', () => {
  it('resolves the package Help index and skill from the service location', async () => {
    expect(await readPackageResource('llms.txt')).toContain('# @agimon-ai/doompi-sandbox');
    expect(await readPackageResource('src/prompts/doompi-use-sandbox/SKILL.md')).toContain('sandbox');
  });
  it('reports a missing resource without rejecting the resource request', async () => {
    expect(await readPackageResource('missing-resource.md')).toBe('(resource unavailable: missing-resource.md)');
  });
});
