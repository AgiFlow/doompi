import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { voice } from '../generated/client';
import {
  activeVoiceSession,
  voiceMediaBrowserState,
  voiceMediaHandoff,
  voiceMediaPageRuntime,
  voiceRealtimeBrowserControls,
} from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore';
import { startVoiceMediaRuntime } from '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_components/VoiceMediaRuntime';
import type { RealtimeBrowserState } from '../src/types/realtime';

const { clients, deviceClose } = vi.hoisted(() => ({
  deviceClose: vi.fn(async () => undefined),
  clients: [] as Array<{
    capture: boolean;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    endRealtime: ReturnType<typeof vi.fn>;
    interruptRealtime: ReturnType<typeof vi.fn>;
    onConnection: (phase: 'connected' | 'disconnected') => void;
    onRealtime: (state: RealtimeBrowserState | undefined) => void;
  }>,
}));

vi.mock('../generated/client', () => ({
  voice: {
    global: {
      liveStatus: vi.fn(async () => ({ ok: true, data: { version: 1 } })),
      liveControl: vi.fn(async () => ({ ok: true, data: { version: 1 } })),
    },
  },
}));
vi.mock('../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/browserMediaDevice', () => ({
  BrowserVoiceMediaDevice: class {
    public readonly capabilities = { capture: true };
    public armUserGesture(): void {}
    public async close(): Promise<void> {
      await deviceClose();
    }
  },
}));
vi.mock('../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/browserMediaIdentity', () => ({
  browserVoiceMediaClientId: () => 'browser',
}));
vi.mock('../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/voiceMediaClient', () => ({
  VoiceMediaClient: class {
    public readonly start = vi.fn();
    public readonly stop = vi.fn(async () => undefined);
    public readonly endRealtime = vi.fn();
    public readonly interruptRealtime = vi.fn();
    public constructor(
      _clientId: string,
      _connectionId: string,
      _transport: unknown,
      device: { capabilities: { capture: boolean } },
      onConnection: (phase: 'connected' | 'disconnected') => void,
      onRealtime: (state: RealtimeBrowserState | undefined) => void,
    ) {
      clients.push({
        capture: device.capabilities.capture,
        start: this.start,
        stop: this.stop,
        endRealtime: this.endRealtime,
        interruptRealtime: this.interruptRealtime,
        onConnection,
        onRealtime,
      });
    }
  },
}));

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

afterEach(() => {
  voiceMediaPageRuntime.update(() => undefined);
  activeVoiceSession.update(() => null);
  voiceMediaHandoff.update(() => undefined);
  clients.length = 0;
  voiceMediaBrowserState.reset();
  voiceRealtimeBrowserControls.reset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('page-global live media lifetime', () => {
  it('keeps its single live browser client through session focus and agent ownership changes', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      sessionStorage: {},
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
    });
    const mount = (sessionId: string): WebPluginRuntime =>
      ({ mount: { scope: 'session', sessionId } }) as WebPluginRuntime;
    startVoiceMediaRuntime(mount('source'));
    await eventually(() => expect(clients).toHaveLength(2));
    const live = clients.find((client) => !client.capture);
    expect(live?.start).toHaveBeenCalledOnce();

    activeVoiceSession.update(() => 'source');
    startVoiceMediaRuntime(mount('target'));
    activeVoiceSession.update(() => 'target');
    await eventually(() =>
      expect(clients.some((client) => client.capture && client.start.mock.calls.length > 0)).toBe(true),
    );
    expect(clients.filter((client) => !client.capture)).toHaveLength(1);
    expect(live?.stop).not.toHaveBeenCalled();
    expect(live?.endRealtime).not.toHaveBeenCalled();

    listeners.get('pagehide')?.();
    await eventually(() => expect(live?.stop).toHaveBeenCalledOnce());
  });
  it('keeps global browser controls pinned to the companion while a session mounts', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      sessionStorage: {},
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
    });
    startVoiceMediaRuntime({} as WebPluginRuntime);
    await eventually(() => expect(clients).toHaveLength(1));
    const live = clients[0]!;
    live.onRealtime({ connection: 'connected', listening: true, speaking: false, muted: false });
    expect(voiceMediaBrowserState.store.state?.sessionId).toBeNull();
    const controls = voiceRealtimeBrowserControls.store.state;
    expect(controls?.sessionId).toBeNull();
    controls?.mute(true);
    controls?.interrupt();
    await eventually(() => expect(voice.global.liveControl).toHaveBeenCalledTimes(2));
    expect(voice.global.liveControl).toHaveBeenNthCalledWith(1, { body: { action: 'mute' } });
    expect(voice.global.liveControl).toHaveBeenNthCalledWith(2, { body: { action: 'interrupt' } });
    vi.mocked(voice.global.liveControl).mockResolvedValueOnce({ ok: false, error: 'Control refused' } as never);
    controls?.mute(false);
    await vi.waitFor(() => expect(voiceMediaBrowserState.store.state?.realtime?.error).toBe('Control refused'));
    live.onConnection('disconnected');
    expect(voiceMediaBrowserState.store.state?.phase).toBe('conflict');
    startVoiceMediaRuntime({ mount: { scope: 'session', sessionId: 'target' } } as WebPluginRuntime);
    await eventually(() => expect(clients).toHaveLength(2));
    expect(voiceRealtimeBrowserControls.store.state?.sessionId).toBeNull();
    controls?.end();
    await eventually(() => expect(voice.global.liveControl).toHaveBeenCalledWith({ body: { action: 'end' } }));
    expect(live.endRealtime).toHaveBeenCalledOnce();
    live.onRealtime(undefined);
    expect(voiceRealtimeBrowserControls.store.state?.sessionId).not.toBeNull();
    listeners.get('pagehide')?.();
    await eventually(() => expect(live.stop).toHaveBeenCalledOnce());
  });
  it('stages a legacy handoff without closing its microphone until explicit stop', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      sessionStorage: {},
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
    });
    startVoiceMediaRuntime({ mount: { scope: 'session', sessionId: 'source' } } as WebPluginRuntime);
    activeVoiceSession.update(() => 'source');
    await eventually(() => expect(clients).toHaveLength(2));
    const source = clients.find((client) => client.capture)!;
    voiceMediaHandoff.update(() => ({
      id: 'transfer',
      phase: 'preparing',
      sourceSessionId: 'source',
      targetSessionId: 'target',
    }));
    activeVoiceSession.update(() => null);
    await eventually(() => expect(clients).toHaveLength(2));
    expect(source.stop).not.toHaveBeenCalled();
    expect(deviceClose).not.toHaveBeenCalled();
    voiceMediaHandoff.update(() => ({
      id: 'transfer',
      phase: 'rebinding',
      sourceSessionId: 'source',
      targetSessionId: 'target',
    }));
    await eventually(() => expect(clients).toHaveLength(3));
    expect(source.stop).toHaveBeenCalledOnce();
    expect(deviceClose).not.toHaveBeenCalled();
    activeVoiceSession.update(() => 'target');
    voiceMediaHandoff.update(() => undefined);
    await vi.waitFor(() =>
      expect((voiceMediaPageRuntime.store.state as unknown as { ownedSessionId: string | null }).ownedSessionId).toBe(
        'target',
      ),
    );
    expect(deviceClose).not.toHaveBeenCalled();
    activeVoiceSession.update(() => null);
    await vi.waitFor(() => expect(deviceClose).toHaveBeenCalledOnce());
    listeners.get('pagehide')?.();
  });
  it('surfaces unsupported global live status without acquiring media or retrying consent', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      sessionStorage: {},
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
    });
    vi.mocked(voice.global.liveStatus).mockResolvedValueOnce({ ok: false, error: 'unsupported' } as never);
    startVoiceMediaRuntime({} as WebPluginRuntime);
    await vi.waitFor(() => expect(voiceMediaBrowserState.store.state?.realtime?.connection).toBe('failed'));
    expect(clients).toHaveLength(0);
    expect(voiceMediaBrowserState.store.state?.phase).toBe('conflict');
    expect(voiceRealtimeBrowserControls.store.state).toBeUndefined();
    listeners.get('pagehide')?.();
  });
  it('keeps microphone consent untouched when host status cannot be reached', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
      sessionStorage: {},
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string) => listeners.delete(event),
    });
    vi.mocked(voice.global.liveStatus).mockRejectedValueOnce('network offline');
    startVoiceMediaRuntime({} as WebPluginRuntime);
    await vi.waitFor(() => expect(voiceMediaBrowserState.store.state?.realtime?.error).toBe('network offline'));
    expect(clients).toHaveLength(0);
    listeners.get('pagehide')?.();
  });
});
