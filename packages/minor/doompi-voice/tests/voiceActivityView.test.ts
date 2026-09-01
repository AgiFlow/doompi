import { describe, expect, it } from 'vitest';
import { voiceActivityView } from '../src/web/voiceActivityView.ts';

describe('reading the voice status line', () => {
  it('says nothing is listening when the session reports nothing', () => {
    for (const quiet of [undefined, '', '   ']) {
      const view = voiceActivityView(quiet);
      expect(view).toMatchObject({ mode: 'off', phase: 'idle', active: false });
      expect(view.label).toBe('not listening');
    }
  });

  it('names each autonomous phase, and marks the ones that want a person', () => {
    expect(voiceActivityView('voice auto: listening')).toMatchObject({
      mode: 'auto',
      phase: 'listening',
      label: 'listening',
      tone: 'live',
      active: true,
    });
    expect(voiceActivityView('voice auto: hearing speech')).toMatchObject({ phase: 'hearing', tone: 'live' });
    expect(voiceActivityView('voice auto: processing while listening')).toMatchObject({
      phase: 'processing',
      label: 'transcribing',
    });
    expect(voiceActivityView('voice auto: narrating and listening')).toMatchObject({ phase: 'narrating' });
    // These two are blocked on the reader, so they read as attention, not activity.
    expect(voiceActivityView('voice auto: confirmation needed')).toMatchObject({
      phase: 'confirming',
      tone: 'attention',
    });
    expect(voiceActivityView('voice auto: waiting for keyboard input')).toMatchObject({
      phase: 'waiting',
      tone: 'attention',
    });
    expect(voiceActivityView('voice auto: draining')).toMatchObject({ phase: 'draining', tone: 'attention' });
    expect(voiceActivityView('voice auto: composing, listening')).toMatchObject({
      phase: 'composing',
      label: 'composing prompt',
      tone: 'attention',
    });
    expect(voiceActivityView('voice auto: sending composed prompt')).toMatchObject({
      phase: 'sending',
      label: 'sending draft',
      tone: 'live',
    });
  });

  it('reports microphone mute independently from autonomous narration', () => {
    expect(voiceActivityView('voice auto: microphone muted')).toMatchObject({
      mode: 'auto',
      phase: 'muted',
      active: false,
      microphoneMuted: true,
    });
    expect(voiceActivityView('voice auto: narrating, microphone muted')).toMatchObject({
      phase: 'narrating',
      active: true,
      microphoneMuted: true,
    });
    expect(voiceActivityView('voice auto: listening').microphoneMuted).toBe(false);
  });

  it('reads a manual recording through its spinner, and keeps the elapsed time', () => {
    const recording = voiceActivityView('⣻ voice: recording 1:07');
    expect(recording).toMatchObject({ mode: 'manual', phase: 'recording', tone: 'attention', active: true });
    // The clock is the one number worth showing while a microphone is open.
    expect(recording.elapsed).toBe('1:07');

    const transcribing = voiceActivityView('⣹ voice: transcribing');
    expect(transcribing).toMatchObject({ mode: 'manual', phase: 'transcribing', tone: 'live', elapsed: '' });
  });

  it('shows an unfamiliar line as the session wrote it rather than hiding it', () => {
    const view = voiceActivityView('voice auto: rehearsing');
    expect(view.label).toBe('rehearsing');
    expect(view.active).toBe(true);
  });
});
