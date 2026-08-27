import { readFile } from 'node:fs/promises';
import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { browserVoiceMediaClientId } from '../web/browserMediaIdentity.ts';
import { VoiceComposerAction } from '../web/VoiceComposerAction.tsx';

describe('browser voice media', () => {
  it('publishes both one-shot and autonomous browser controls with a page-lifetime runtime', async () => {
    const source = await readFile(new URL('../web/index.ts', import.meta.url), 'utf8');

    expect(source).toContain("overlays: [{ id: 'voice-media-runtime', component: VoiceMediaRuntime }]");
    expect(source).toContain("composerActions: [{ id: 'voice', component: VoiceComposerAction }]");
    expect(source).toContain("id: 'voice.capture'");
    expect(source).toContain("command: 'voice'");
    expect(source).toContain("id: 'voice.toggle'");
    expect(source).toContain("command: 'minor voice-auto'");
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
    expect(source).toContain("message: '/voice'");
    expect(source).toContain('stop recording and fill the prompt');
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
