import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ existsSync: () => false }));

describe('readVoicePrompt without package resources', () => {
  it('fails clearly instead of searching above the filesystem root', async () => {
    const { readVoicePrompt } = await import('../src/services/voicePrompt');

    await expect(readVoicePrompt()).rejects.toThrow('Cannot locate Voice package resources.');
  });
});
