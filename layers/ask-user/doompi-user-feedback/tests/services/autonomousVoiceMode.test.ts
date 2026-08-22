import { DOOM_VOICE_AUTO_MODE_ID, DOOM_VOICE_SOURCE } from '@agimon-ai/doompi-extension-contracts/narration';
import type { MinorModeActivation, MinorModeRecord } from '@agimon-ai/doompi-extension-contracts/mode';
import { describe, expect, it } from 'vitest';
import { isAutonomousVoiceActive, isAutonomousVoiceRecord } from '../../src/services/autonomousVoiceMode.js';

function record(
  activation: MinorModeActivation = 'active',
  source = DOOM_VOICE_SOURCE,
  id = DOOM_VOICE_AUTO_MODE_ID,
): MinorModeRecord {
  return {
    descriptor: { source, id, label: 'VOICE', description: 'Voice mode', order: 30, actions: [] },
    state: { activation, condition: 'ready', actions: [] },
    ownerGeneration: 'owner-1',
    registrationId: 'registration-1',
    stateRevision: 1,
  };
}

describe('autonomous voice mode detection', () => {
  it('matches the voice package autonomous mode while it is active', () => {
    expect(isAutonomousVoiceRecord(record())).toBe(true);
  });

  it('rejects transitional activations', () => {
    for (const activation of ['activating', 'deactivating', 'inactive'] as const) {
      expect(isAutonomousVoiceRecord(record(activation))).toBe(false);
    }
  });

  it('requires both the exact source and the voice-auto mode id', () => {
    expect(isAutonomousVoiceRecord(record('active', '@example/not-voice'))).toBe(false);
    expect(isAutonomousVoiceRecord(record('active', DOOM_VOICE_SOURCE, 'other-mode'))).toBe(false);
  });

  it('scans a catalog listing', () => {
    expect(isAutonomousVoiceActive([record('inactive'), record('active')])).toBe(true);
    expect(isAutonomousVoiceActive([record('inactive')])).toBe(false);
    expect(isAutonomousVoiceActive([])).toBe(false);
  });
});
