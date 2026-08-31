import { readFile } from 'node:fs/promises';
import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION } from '../src/types/voiceOwnership.ts';
import { browserVoiceMediaClientId } from '../web/browserMediaIdentity.ts';
import { VoiceActivitySection } from '../web/VoiceActivitySection.tsx';
import { VoiceComposerAction } from '../web/VoiceComposerAction.tsx';
import {
  activeVoiceSession,
  voiceMediaBrowserState,
  voiceMediaWakes,
  voiceOwnershipChannel,
  waitForVoiceMediaWake,
} from '../web/voiceMediaWakeStore.ts';

afterEach(() => {
  activeVoiceSession.reset();
  voiceMediaBrowserState.reset();
  voiceMediaWakes.reset();
});

describe('browser voice media', () => {
  it('publishes both controls and page-lifetime media channels', async () => {
    const source = await readFile(new URL('../web/index.ts', import.meta.url), 'utf8');

    expect(source).toContain('channels: [voiceMediaWakeChannel, voiceOwnershipChannel]');
    expect(source).toContain('start: startVoiceMediaRuntime');
    expect(source).not.toContain('voice-media-runtime');
    expect(source).toContain("composerActions: [{ id: 'voice', component: VoiceComposerAction }]");
    expect(source).not.toContain("id: 'voice.capture'");
    expect(source).not.toContain("command: 'voice'");
    expect(source).toContain("id: 'voice.toggle'");
    expect(source).toContain("command: 'minor voice-auto'");
    const runtimeSource = await readFile(new URL('../web/VoiceMediaRuntime.tsx', import.meta.url), 'utf8');
    expect(runtimeSource).toContain('this.device.armUserGesture()');
  });

  it('keeps process-local manual recording out of the browser minor-mode picker', async () => {
    const source = await readFile(new URL('../src/adapters/pi/voice.ts', import.meta.url), 'utf8');
    const start = source.indexOf("label: 'Manual voice'");
    const manualAction = source.slice(start, source.indexOf("id: 'deactivate'", start));

    expect(manualAction).toContain("contexts: ['tui']");
    expect(manualAction).not.toContain("'headless'");
  });

  it('keeps the server-selected session in one reactive page-wide store', () => {
    const published: Array<string | null> = [];
    const subscription = activeVoiceSession.store.subscribe(() => published.push(activeVoiceSession.store.state));
    const payload = {
      type: 'browser-media-session',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      activeSessionId: 'session-b',
    } as const;

    expect(voiceOwnershipChannel.parse(payload)).toEqual(payload);
    expect(voiceOwnershipChannel.parse(null)).toBeNull();
    voiceOwnershipChannel.apply('session-a', payload);
    voiceOwnershipChannel.apply('session-b', payload);
    voiceOwnershipChannel.drop('session-a');
    expect(activeVoiceSession.store.state).toBe('session-b');
    voiceOwnershipChannel.drop('session-b');

    expect(activeVoiceSession.store.state).toBeNull();
    expect(published).toEqual(['session-b', null]);
    subscription.unsubscribe();
  });

  it('releases media wake listeners on abort and timeout', async () => {
    const aborted = new AbortController();
    const abortWait = waitForVoiceMediaWake('session-a', 'event-a', 0, 100, aborted.signal);
    aborted.abort();
    await expect(abortWait).resolves.toBeUndefined();

    await expect(
      waitForVoiceMediaWake('session-a', 'event-a', 0, 1, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('identifies a sealed remote controller when it claims the session media lease', async () => {
    const source = await readFile(new URL('../web/clientMediaTransport.ts', import.meta.url), 'utf8');

    expect(source).toContain("controlLocation: sealedTransport.active() ? 'remote' : 'local'");
  });

  it('keeps the iOS Web Audio capture graph live without audible microphone feedback', async () => {
    const source = await readFile(new URL('../web/browserMediaDevice.ts', import.meta.url), 'utf8');

    expect(source).toContain("new URL('./browserCaptureWorklet.js?no-inline', import.meta.url).href");
    expect(source).toContain('const SILENT_OUTPUT_GAIN = 1e-8');
    expect(source).toContain('muted.gain.value = SILENT_OUTPUT_GAIN');
  });

  it('fills the composer action with manual recording and blocks it during autonomous voice', async () => {
    const source = await readFile(new URL('../web/VoiceComposerAction.tsx', import.meta.url), 'utf8');

    expect(source).toContain('data-testid="composer-voice-action"');
    expect(source).toContain('data-testid="composer-voice-error"');
    expect(source).toContain('new ManualComposerRecorder(appendComposerDraft');
    expect(source).toContain('manualRecorder.current?.toggle(sessionId)');
    expect(source).toContain('sessionId === null || autonomous');
    expect(source).toContain('manual voice is unavailable while autonomous voice is active');
    expect(source).toContain('recorder?.dispose()');
    expect(source).not.toContain('sendSessionFrame');
    expect(source).not.toContain('/minor voice-auto deactivate');
  });

  it('renders the manual record button as unavailable throughout autonomous capture', () => {
    for (const status of [
      'voice auto: starting',
      'voice auto: listening',
      'voice auto: hearing speech',
      'voice auto: composing, listening',
      'voice auto: narrating and listening',
    ]) {
      const rendered = renderPlugin(
        VoiceComposerAction,
        slotPropsFixture({ statuses: { 'doom-voice': status } }).props,
      );
      expect(rendered.error).toBeUndefined();
      expect(rendered.html).toContain('aria-label="manual voice is unavailable while autonomous voice is active"');
      expect(rendered.html).toContain('disabled=""');
    }

    const manual = renderPlugin(VoiceComposerAction, slotPropsFixture({ statuses: {} }).props);
    expect(manual.html).toContain('aria-label="start voice recording"');
    expect(manual.html).not.toContain('disabled=""');
  });

  it('does not expose the session-backed manual recording control in the browser activity dock', async () => {
    const source = await readFile(new URL('../web/VoiceActivitySection.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain("sendCommand('/voice')");
    expect(source).not.toContain('voice-recording-stop');
    expect(source).toContain("`/voice-auto ${view.microphoneMuted ? 'unmute' : 'mute'}`");
  });

  it('shows an accessible autonomous microphone toggle only while autonomous voice is applicable', async () => {
    const active = renderPlugin(
      VoiceActivitySection,
      slotPropsFixture({ statuses: { 'doom-voice': 'voice auto: listening' } }).props,
    );
    expect(active.html).toContain('data-testid="voice-autonomous-microphone-toggle"');
    expect(active.html).toContain('aria-label="mute autonomous voice microphone"');

    const muted = renderPlugin(
      VoiceActivitySection,
      slotPropsFixture({ statuses: { 'doom-voice': 'voice auto: microphone muted' } }).props,
    );
    expect(muted.html).toContain('aria-label="unmute autonomous voice microphone"');
    expect(muted.html).toContain('aria-pressed="true"');

    const manual = renderPlugin(
      VoiceActivitySection,
      slotPropsFixture({ statuses: { 'doom-voice': 'voice: recording 0:03' } }).props,
    );
    expect(manual.html).not.toContain('voice-autonomous-microphone-toggle');

    const source = await readFile(new URL('../web/VoiceActivitySection.tsx', import.meta.url), 'utf8');
    expect(source).toContain("`/voice-auto ${view.microphoneMuted ? 'unmute' : 'mute'}`");
  });

  it('shows a browser lease conflict instead of a misleading listening state', () => {
    voiceMediaBrowserState.update(() => ({ sessionId: 'session-a', phase: 'conflict' }));
    const fixture = slotPropsFixture({
      sessionId: 'session-a',
      statuses: { 'doom-voice': 'voice auto: listening' },
    });

    const activity = renderPlugin(VoiceActivitySection, fixture.props);
    const composer = renderPlugin(VoiceComposerAction, fixture.props);

    expect(activity.html).toContain('data-voice-phase="conflict"');
    expect(activity.html).toContain('microphone unavailable');
    expect(activity.html).toContain('another browser tab owns voice capture');
    expect(composer.html).toContain('data-voice-phase="blocked"');
    expect(composer.html).toContain('manual voice is unavailable while autonomous voice is active');
  });
  it('switches browser media from the server-selected global value without acknowledgements', async () => {
    const source = await readFile(new URL('../web/VoiceMediaRuntime.tsx', import.meta.url), 'utf8');

    expect(source).toContain('activeVoiceSession.store.subscribe');
    expect(source).toContain('this.boundSessionId = sessionId');
    expect(source).not.toContain('sendHubFrame');
    expect(source).not.toContain('browser-media-ack');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('sessionStorage.setItem');
  });

  it('keeps one browser media identity across runtime remounts in the same tab', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    let sequence = 0;
    const createId = (): string => `id-${String(++sequence)}`;

    expect(browserVoiceMediaClientId(storage, createId)).toBe('browser-id-1');
    expect(browserVoiceMediaClientId(storage, createId)).toBe('browser-id-1');
    expect(sequence).toBe(1);
  });
});
