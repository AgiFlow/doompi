import { readFile } from 'node:fs/promises';

import { renderPlugin, slotPropsFixture, toolMessagePropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activeVoiceSession,
  voiceGlobalActivitySource,
  voiceMediaBrowserState,
  voiceRealtimeBrowserControls,
  voiceMediaWakes,
  voiceOwnershipChannel,
  waitForVoiceMediaWake,
} from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore';
import { voiceMicrophone } from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMicrophoneStore';
import { VoiceActivitySection } from '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceActivitySection';
import { VoiceComposerAction } from '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceComposerAction';
import {
  microphoneOptions,
  VoiceMicrophoneDialog,
} from '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceMicrophoneDialog';
import { browserVoiceMediaClientId } from '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/browserMediaIdentity';
import { VoiceToolMessage } from '../src/extensions/workspaces/sessions/(frontend)/tool/_components/VoiceToolMessage';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION } from '../src/types/voiceOwnership';

afterEach(() => {
  activeVoiceSession.reset();
  voiceMediaBrowserState.reset();
  voiceRealtimeBrowserControls.reset();
  voiceMediaWakes.reset();
  voiceMicrophone.reset();
});

describe('browser voice media', () => {
  it('reuses page voice state across independently evaluated session compositions', async () => {
    vi.resetModules();
    const first = await import('../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore');
    vi.resetModules();
    const second = await import('../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore');

    expect(second.activeVoiceSession).toBe(first.activeVoiceSession);
    expect(second.voiceMediaBrowserState).toBe(first.voiceMediaBrowserState);
    expect(second.voiceRealtimeBrowserControls).toBe(first.voiceRealtimeBrowserControls);
    expect(second.voiceMediaWakes).toBe(first.voiceMediaWakes);

    first.activeVoiceSession.reset();
    first.voiceMediaBrowserState.reset();
    first.voiceRealtimeBrowserControls.reset();
    first.voiceMediaWakes.reset();
  });
  it('publishes both controls and page-lifetime media channels', async () => {
    const source = (
      await Promise.all(
        [
          'channel/voice-media-wake.web.ts',
          'channel/voice-ownership.web.ts',
          'fill/Voice.composer-actions.web.tsx',
          'fill/Voice.overlay.web.tsx',
          'leader/toggle.web.ts',
          'lifecycle/start.web.ts',
        ].map((file) =>
          readFile(new URL(`../src/extensions/workspaces/sessions/(frontend)/${file}`, import.meta.url), 'utf8'),
        ),
      )
    ).join('\n');

    expect(source).toContain('voiceMediaWakeChannel');
    expect(source).toContain('voiceOwnershipChannel');
    expect(source).toContain('startVoiceMediaRuntime');
    expect(source).not.toContain('voice-media-runtime');
    expect(source).toContain("id: 'voice'");
    expect(source).toContain("slot: 'overlay'");
    expect(source).not.toContain("id: 'voice.capture'");
    expect(source).not.toContain("command: 'voice'");
    expect(source).toContain("id: 'voice.toggle'");
    expect(source).toContain("command: 'minor voice-auto'");
    const runtimeSource = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_components/VoiceMediaRuntime.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(runtimeSource).toContain('this.device.armUserGesture()');
  });

  it('does not classify autonomous voice capture as background work', async () => {
    const source = await readFile(
      new URL('../src/extensions/workspaces/sessions/(frontend)/activity-group/voice.web.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('marksBackgroundWork: false');
  });

  it('presents narration as readable conversational output', async () => {
    const source = await readFile(
      new URL('../src/extensions/workspaces/sessions/(frontend)/tool/narrate.web.tsx', import.meta.url),
      'utf8',
    );
    const rendered = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({
        toolName: 'narrate',
        args: { text: 'The migration is complete.' },
        running: false,
      }).props,
    );

    expect(source).toContain('tools: [VOICE_NARRATE_TOOL]');
    expect(source).toContain("timelinePresentation: 'message'");
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="narration-message"');
    expect(rendered.html).toContain('aria-label="narration"');
    expect(rendered.html).toContain('The migration is complete.');
    expect(rendered.html).not.toContain('data-slot="message-item"');
  });

  it('keeps narration state readable without changing facade calls into messages', () => {
    const playing = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({ toolName: 'narrate', args: { text: 'Still working.' }, running: true }).props,
    );
    const failed = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({ toolName: 'narrate', args: {}, running: false, isError: true }).props,
    );
    const facade = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({
        toolName: 'describe_voice_tools',
        args: { names: ['minor_mode'] },
        running: false,
        result: { content: [{ type: 'text', text: 'Catalog ready.' }], details: null },
      }).props,
    );
    const batch = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({
        toolName: 'use_voice_tools',
        args: { calls: [{ name: 'one' }, { name: 'two' }] },
        running: false,
      }).props,
    );
    const idleFacade = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({ toolName: 'describe_voice_tools', running: false }).props,
    );
    const runningFacade = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({ toolName: 'describe_voice_tools', running: true }).props,
    );
    const failedFacade = renderPlugin(
      VoiceToolMessage,
      toolMessagePropsFixture({ toolName: 'describe_voice_tools', running: false, isError: true }).props,
    );

    expect(playing.html).toContain('data-narration-state="playing"');
    expect(failed.html).toContain('data-narration-state="failed"');
    expect(failed.html).toContain('Narration unavailable.');
    expect(facade.html).toContain('data-slot="message-item"');
    expect(facade.html).toContain('minor_mode');
    expect(facade.html).toContain('Catalog ready.');
    expect(batch.html).toContain('2 capabilities');
    expect(idleFacade.html).toContain('discover');
    expect(runningFacade.html).toContain('Working');
    expect(failedFacade.html).toContain('ERROR');
  });

  it('keeps process-local manual recording out of the browser minor-mode picker', async () => {
    const source = await readFile(new URL('../src/services/voice/index.ts', import.meta.url), 'utf8');
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
    const source = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/clientMediaTransport.ts',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain("const controlLocation = sealedTransport.active() ? 'remote' : 'local'");
    expect(source).toContain('this.controlLocation = controlLocation');
  });

  it('keeps the iOS Web Audio capture graph live without audible microphone feedback', async () => {
    const source = await readFile(
      new URL('../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/browserMediaDevice.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("import browserCaptureWorkletUrl from './browserCaptureWorklet.js?url'");
    expect(source).toContain('audioWorklet.addModule(browserCaptureWorkletUrl)');
    expect(source).toContain('const SILENT_OUTPUT_GAIN = 1e-8');
    expect(source).toContain('muted.gain.value = SILENT_OUTPUT_GAIN');
  });

  it('fills the composer action with manual recording and blocks it during autonomous voice', async () => {
    const source = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceComposerAction.tsx',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain('data-testid="composer-voice-action"');
    expect(source).not.toContain('data-testid="composer-voice-error"');
    expect(source).toMatch(/new ManualComposerRecorder\(\s*appendComposerDraft/u);
    expect(source).toContain('manualRecorder.current?.toggle(sessionId)');
    expect(source).toContain('sessionId === null || autonomous');
    expect(source).toContain('manual voice is unavailable while autonomous voice is active');
    expect(source).toContain('recorder?.dispose()');
    expect(source).not.toContain('sendSessionFrame');
    expect(source).not.toContain('/minor voice-auto deactivate');
    // The composer no longer knows a device exists; it records on whatever the client is on.
    expect(source).not.toContain('voice-microphone-picker');
    expect(source).not.toContain('voiceMicrophoneStore');
    expect(source).not.toContain('startManualBrowserRecording');
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
    expect(manual.html).not.toContain('Voice microphone');
  });

  // Radix portals dialog content out of the render tree, so `html` is empty either way.
  // These assert the component mounts in both states; the option labels are checked below.
  it('mounts the microphone dialog whether or not a capture is waiting', () => {
    const closed = renderPlugin(VoiceMicrophoneDialog, slotPropsFixture({}).props);
    expect(closed.error).toBeUndefined();

    voiceMicrophone.update(() => ({
      inputs: [
        { deviceId: 'built-in', groupId: 'internal', label: 'MacBook microphone' },
        { deviceId: 'usb', groupId: 'external', label: 'USB microphone' },
      ],
      choice: () => undefined,
    }));
    expect(renderPlugin(VoiceMicrophoneDialog, slotPropsFixture({}).props).error).toBeUndefined();
  });

  it('keeps two identically named inputs distinguishable', () => {
    expect(
      microphoneOptions([
        { deviceId: 'built-in', label: 'MacBook microphone' },
        { deviceId: 'usb', label: 'USB microphone' },
      ]),
    ).toEqual(['MacBook microphone', 'USB microphone']);

    expect(
      microphoneOptions([
        { deviceId: 'aaaaaa11', label: 'USB microphone' },
        { deviceId: 'bbbbbb22', label: 'USB microphone' },
      ]),
    ).toEqual(['USB microphone · aaaaaa', 'USB microphone · bbbbbb']);

    expect(microphoneOptions([{ deviceId: 'x', label: '' }])).toEqual(['Microphone']);
  });
  it('does not expose the session-backed manual recording control in the browser activity dock', async () => {
    const source = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceActivitySection.tsx',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).not.toContain("sendCommand('/voice')");
    expect(source).not.toContain('voice-recording-stop');
    expect(source).toContain("`/voice-auto ${view.microphoneMuted ? 'unmute' : 'mute'}`");
  });

  it('offers explicit global Live start only for an idle session, without changing the legacy mode', async () => {
    const idle = renderPlugin(VoiceActivitySection, slotPropsFixture({ sessionId: 'session-a' }).props);
    expect(idle.error).toBeUndefined();
    expect(idle.html).toContain('data-testid="voice-global-live-start"');
    expect(idle.html).toContain('start Live');
    expect(idle.html).not.toContain('microphone live');

    for (const props of [
      { sessionId: null },
      { sessionId: 'session-a', statuses: { 'doom-voice': 'voice auto: listening' } },
    ]) {
      expect(renderPlugin(VoiceActivitySection, slotPropsFixture(props).props).html).not.toContain(
        'voice-global-live-start',
      );
    }
    voiceMediaBrowserState.update(() => ({
      sessionId: null,
      phase: 'connected',
      realtime: { connection: 'connected', listening: true, speaking: false, muted: false },
    }));
    const globalLive = renderPlugin(VoiceActivitySection, slotPropsFixture({ sessionId: 'session-a' }).props).html;
    expect(globalLive).not.toContain('voice-global-live-start');
    expect(globalLive).toContain('data-testid="voice-global-live-transfer"');
    expect(globalLive).toContain('route Live here');
    expect(renderPlugin(VoiceActivitySection, slotPropsFixture({ sessionId: null }).props).html).not.toContain(
      'voice-global-live-transfer',
    );

    const source = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceActivitySection.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).toContain('voice.global.liveControl({ body: { action, sessionId } })');
    expect(source).toContain("controlGlobalLive('activate')");
    expect(source).toContain("controlGlobalLive('transfer')");
    expect(source).toContain('role="alert"');
    expect(source).not.toContain('getUserMedia');
    expect(source).not.toContain("sendSessionFrame(sessionId, { type: 'prompt', message: '/voice-auto");
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

    const source = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/fill/_components/VoiceActivitySection.tsx',
        import.meta.url,
      ),
      'utf8',
    );
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

  it('renders accurate realtime connection controls and the local interruption limitation', () => {
    voiceMediaBrowserState.update(() => ({
      sessionId: 'session-a',
      phase: 'connected',
      realtime: { connection: 'connected', listening: true, speaking: true, muted: false },
      realtimeOutputInterrupted: true,
    }));
    voiceRealtimeBrowserControls.update(() => ({
      sessionId: 'session-a',
      mute: () => undefined,
      interrupt: () => undefined,
      end: () => undefined,
    }));

    const rendered = renderPlugin(VoiceActivitySection, slotPropsFixture({ sessionId: 'session-a' }).props);

    expect(rendered.html).toContain('data-voice-phase="realtime-connected"');
    expect(rendered.html).toContain('realtime voice live');
    expect(rendered.html).toContain('>mute<');
    expect(rendered.html).toContain('>interrupt<');
    expect(rendered.html).toContain('>end<');
    expect(rendered.html).toContain('will stay silent until this realtime session ends');
  });

  it('blocks manual recording in another focused session while global live voice owns media', () => {
    voiceMediaBrowserState.update(() => ({
      sessionId: null,
      phase: 'connected',
      realtime: { connection: 'connected', listening: true, speaking: false, muted: false },
    }));
    const fixture = slotPropsFixture({ sessionId: 'session-b', statuses: {} });
    const composer = renderPlugin(VoiceComposerAction, fixture.props);
    expect(composer.error).toBeUndefined();
    expect(composer.html).toContain('aria-label="manual voice is unavailable while autonomous voice is active"');
    expect(composer.html).toContain('disabled=""');
  });

  it('keeps global realtime controls available with another or no session focused', () => {
    voiceMediaBrowserState.update(() => ({
      sessionId: null,
      phase: 'connected',
      realtime: { connection: 'connected', listening: true, speaking: false, muted: false },
    }));
    voiceRealtimeBrowserControls.update(() => ({
      sessionId: null,
      mute: () => undefined,
      interrupt: () => undefined,
      end: () => undefined,
    }));

    for (const sessionId of ['session-b', null]) {
      const rendered = renderPlugin(VoiceActivitySection, slotPropsFixture({ sessionId }).props);
      expect(rendered.error).toBeUndefined();
      expect(rendered.html).toContain('data-voice-phase="realtime-connected"');
      expect(rendered.html).toContain('>mute<');
      expect(rendered.html).toContain('>interrupt<');
      expect(rendered.html).toContain('>end<');
      expect(voiceGlobalActivitySource.isActive(sessionId)).toBe(true);
    }
    voiceMediaBrowserState.reset();
    expect(voiceGlobalActivitySource.isActive('session-b')).toBe(false);
  });

  it('keeps browser media page-global while route-scoped plugin runtimes remount', async () => {
    const source = await readFile(
      new URL(
        '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_components/VoiceMediaRuntime.tsx',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain('activeVoiceSession.store.subscribe');
    expect(source).toContain('voiceMediaPageRuntime.store.state');
    expect(source).toContain('voiceMediaPageRuntime.update');
    expect(source).toContain("window.addEventListener('pagehide', this.closeOnPageHide");
    expect(source).toContain('this.boundSessionId = sessionId');
    expect(source).toContain('return () => undefined');
    expect(source).not.toContain('activeVoiceSession.reset()');
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
