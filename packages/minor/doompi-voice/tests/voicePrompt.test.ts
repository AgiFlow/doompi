import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';
import { describe, expect, it } from 'vitest';

describe('Voice prompt resource', () => {
  // Source and compiled resolution, and the empty-string degrade, are the shared
  // reader's contract, covered by doompi-core's packageResource test. What is local
  // is that this package ships the skill the Voice resource names.
  it('reads the packaged Voice skill from the package resource tree', async () => {
    const prompt = await readPackageResource(import.meta.url, 'src/prompts/doompi-use-voice/SKILL.md');

    expect(prompt).toMatch(/^---\nname: doompi-use-voice$/mu);
    expect(prompt).toContain('# Use Doom Pi Voice');
  });
});
