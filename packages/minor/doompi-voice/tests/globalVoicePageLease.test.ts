import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activeVoiceSession,
  voiceMediaHandoff,
  voiceMediaPageRuntime,
} from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore';
import { startVoiceMediaRuntime } from '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_components/VoiceMediaRuntime';

const { clients } = vi.hoisted(() => ({
  clients: [] as Array<{
    capture: boolean;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    endRealtime: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('../generated/client', () => ({
  voice: { global: { liveStatus: vi.fn(async () => ({ ok: true, data: { version: 1 } })) } },
}));
vi.mock('../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/browserMediaDevice', () => ({
  BrowserVoiceMediaDevice: class {
    public readonly capabilities = { capture: true };
    public armUserGesture(): void {}
    public async close(): Promise<void> {}
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
    public constructor(
      _clientId: string,
      _connectionId: string,
      _transport: unknown,
      device: { capabilities: { capture: boolean } },
    ) {
      clients.push({
        capture: device.capabilities.capture,
        start: this.start,
        stop: this.stop,
        endRealtime: this.endRealtime,
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
});
