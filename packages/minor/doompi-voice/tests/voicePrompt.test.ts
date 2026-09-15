import { describe, expect, it } from 'vitest';

import { readVoicePrompt } from '../src/services/voicePrompt';

describe('readVoicePrompt', () => {
  it('reads the packaged Voice skill from the package resource tree', async () => {
    const prompt = await readVoicePrompt();

    expect(prompt).toMatch(/^---\nname: doompi-use-voice$/mu);
    expect(prompt).toContain('# Use Doom Pi Voice');
  });
});
