import { readFile } from 'node:fs/promises';
import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { browserVoiceMediaClientId } from '../web/browserMediaIdentity.ts';
import { VoiceActivitySection } from '../web/VoiceActivitySection.tsx';
import { VoiceComposerAction } from '../web/VoiceComposerAction.tsx';
import { VoiceOwnershipCursor } from '../web/voiceOwnershipCursor.ts';

describe('browser voice media', () => {
  it('publishes both one-shot and autonomous browser controls with a page-lifetime runtime', async () => {
    const source = await readFile(new URL('../web/index.ts', import.meta.url), 'utf8');

    expect(source).toContain('channels: [voiceMediaWakeChannel]');
    expect(source).toContain("overlays: [{ id: 'voice-media-runtime', component: VoiceMediaRuntime }]");
    expect(source).toContain("composerActions: [{ id: 'voice', component: VoiceComposerAction }]");
    expect(source).toContain("id: 'voice.capture'");
    expect(source).toContain("command: 'voice'");
    expect(source).toContain("id: 'voice.toggle'");
    expect(source).toContain("command: 'minor voice-auto'");
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

  it('fills the mobile composer action with manual controls and autonomous phase icons', async () => {
    const source = await readFile(new URL('../web/VoiceComposerAction.tsx', import.meta.url), 'utf8');

    expect(source).toContain('data-testid="composer-voice-action"');
    expect(source).toContain("? '/voice'");
    expect(source).toContain("? '/minor voice-auto deactivate'");
    expect(source).toContain('AudioLinesIcon');
    expect(source).toContain('LoaderIcon');
    expect(source).toContain('MessageIcon');
    expect(source).toContain('SendIcon');
    expect(source).toContain('VolumeIcon');
  });

  it('renders distinct accessible icons for autonomous voice phases', () => {
    const iconFor = (status: string): string => {
      const fixture = slotPropsFixture({ statuses: { 'doom-voice': status } });
      const rendered = renderPlugin(VoiceComposerAction, fixture.props);
      expect(rendered.error).toBeUndefined();
      return /class="lucide lucide-([^ ]+)/u.exec(rendered.html)?.[1] ?? '';
    };

    const phases = [
      'voice auto: listening',
      'voice auto: hearing speech',
      'voice auto: processing while listening',
      'voice auto: composing, listening',
      'voice auto: sending composed prompt',
      'voice auto: narrating and listening',
      'voice auto: confirmation needed',
    ];
    expect(new Set(phases.map(iconFor)).size).toBe(phases.length);

    const recording = renderPlugin(
      VoiceComposerAction,
      slotPropsFixture({ statuses: { 'doom-voice': 'voice: recording 0:03' } }).props,
    );
    expect(recording.html).toContain('aria-label="stop voice recording and fill the prompt"');
    expect(recording.html).toContain('data-voice-phase="recording"');
  });

  it('offers an explicit stop control while manual recording fills the prompt', async () => {
    const source = await readFile(new URL('../web/VoiceActivitySection.tsx', import.meta.url), 'utf8');

    expect(source).toContain('data-testid="voice-recording-stop"');
    expect(source).toContain("sendCommand('/voice')");
    expect(source).toContain('stop recording and fill the prompt');
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
    expect(source).toContain("`/minor voice-auto ${view.microphoneMuted ? 'unmute' : 'mute'}`");
  });

  it('keeps retired hub epochs across browser runtime remounts in the same tab', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const cursor = new VoiceOwnershipCursor(storage);
    const command = (epoch: string, generation: number, revision = 1) => ({
      type: 'browser-media-command' as const,
      version: 1 as const,
      epoch,
      generation,
      revision,
      action: 'attach' as const,
    });

    expect(cursor.accept(command('old-epoch', 20))).toBe(true);
    expect(cursor.accept(command('old-epoch', 20))).toBe(false);
    for (let index = 1; index <= 12; index += 1)
      expect(cursor.accept(command(`new-epoch-${String(index)}`, 1))).toBe(true);
    expect(cursor.accept(command('new-epoch-12', 1, 2))).toBe(true);

    const remounted = new VoiceOwnershipCursor(storage);
    expect(remounted.accept(command('old-epoch', 21))).toBe(false);
    expect(remounted.accept(command('new-epoch-12', 1, 2))).toBe(false);
    expect(remounted.accept(command('new-epoch-12', 1, 3))).toBe(true);
  });

  it('reannounces the browser media runtime while a session remains mounted', async () => {
    const source = await readFile(new URL('../web/VoiceMediaRuntime.tsx', import.meta.url), 'utf8');

    expect(source).toContain('window.setInterval(announce, BROWSER_RUNTIME_ANNOUNCE_MS)');
    expect(source).not.toContain('announcedSessionId');
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
