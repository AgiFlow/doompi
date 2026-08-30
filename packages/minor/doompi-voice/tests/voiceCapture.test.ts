import { describe, expect, it } from 'vitest';
import { canRunVoice, voiceModeState, voiceOwnershipState } from '../src/adapters/pi/voice.ts';

/** The disabled actions of a published state, as the /minor command reads them. */
function blocked(state: ReturnType<typeof voiceModeState>): { id: string; reason?: string }[] {
  return state.actions
    .filter((action) => action.enabled === false)
    .map((action) => ({ id: action.id, ...(action.disabledReason ? { reason: action.disabledReason } : {}) }));
}

describe('browser media ownership', () => {
  it('holds the session lease through manual recording and transcription', () => {
    expect(voiceOwnershipState('idle', 'disabled')).toBe('disabled');
    expect(voiceOwnershipState('recording', 'disabled')).toBe('active');
    expect(voiceOwnershipState('transcribing', 'disabled')).toBe('active');
    expect(voiceOwnershipState('idle', 'starting')).toBe('starting');
  });
});

describe('what a session must be for autonomous voice to run', () => {
  it('needs somewhere to show itself, and does not care how the session is driven', () => {
    // Capture is a local subprocess reading a system audio device, and the
    // agent runs on the same machine either way, so the transport a session
    // is driven over decides nothing.
    expect(canRunVoice({ hasUI: true })).toBe(true);
    expect(canRunVoice({ hasUI: false })).toBe(false);
    expect(canRunVoice(undefined)).toBe(false);
  });

  it('keeps microphone controls out of the manual and autonomous mode actions', () => {
    const state = voiceModeState('disabled', true);
    expect(state.actions.map((action) => action.id)).toEqual(['activate', 'manual', 'deactivate']);
    expect(state.actions.filter((action) => action.enabled).map((action) => action.id)).toEqual(['activate', 'manual']);
    expect(blocked(state)).toEqual([{ id: 'deactivate', reason: 'Autonomous voice is disabled.' }]);
  });

  it('refuses a session with nowhere to show itself, and says why on every action', () => {
    expect(blocked(voiceModeState('disabled', false))).toEqual([
      { id: 'activate', reason: 'Autonomous voice needs a session that can show its indicator.' },
      { id: 'manual', reason: 'Manual voice needs a session that can show its indicator.' },
      { id: 'deactivate', reason: 'Autonomous voice needs a session that can show its indicator.' },
    ]);
  });

  it('defaults to refusing, because registration cannot know the session yet', () => {
    // The mode is registered before any session exists, so the default has to
    // be republished per session; leaving it standing is what made a cockpit
    // session report that voice needed a terminal.
    expect(blocked(voiceModeState('disabled'))).toHaveLength(3);
  });
});
