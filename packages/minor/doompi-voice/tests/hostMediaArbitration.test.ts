import type { DoomHostMediaArbitration } from '@agimon-ai/doompi-core/packageApi';
import { describe, expect, it, vi } from 'vitest';

import { VoiceMediaBroker } from '../src/services/clientMediaApi';
import { VOICE_MEDIA_PROTOCOL_VERSION, VOICE_MEDIA_ROUTES } from '../src/types/clientMedia';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION } from '../src/types/voiceOwnership';

function post(path: string, body: object): Request {
  return new Request(`http://voice.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('host-owned voice media arbitration', () => {
  it('excludes session playback and capture from the persistent global WebRTC companion', async () => {
    const owners = new Set<() => boolean>();
    const mediaArbitration: DoomHostMediaArbitration = {
      register(busy) {
        owners.add(busy);
        return () => {
          owners.delete(busy);
        };
      },
      available(busy) {
        return [...owners].every((other) => other === busy || !other());
      },
    };
    const session = new VoiceMediaBroker({
      sessionId: 'native-session',
      directEvents: { publish: vi.fn() } as never,
      clientConnectWaitMs: 0,
      mediaArbitration,
    });
    const global = new VoiceMediaBroker({
      sessionId: 'global-live-companion',
      globalLive: { ready: () => true },
      realtimeProvider: { createCall: vi.fn(async () => ({ sdp: 'answer', callId: 'call' })) },
      clientConnectWaitMs: 0,
      mediaArbitration,
    });
    const client = { clientId: 'browser', connectionId: 'connection' };
    const connect = (broker: VoiceMediaBroker, capture: boolean, playback: boolean) =>
      broker.fetch(
        post(VOICE_MEDIA_ROUTES.clientConnect, {
          ...client,
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientKind: 'browser',
          controlLocation: 'remote',
          capabilities: { capture, playback, captureActivity: false, autonomousOrchestration: false, realtime: true },
        }),
      );
    try {
      expect((await connect(session, true, true)).status).toBe(200);
      expect((await connect(global, false, false)).status).toBe(200);
      await session.beginPlayback({ playbackId: 'speech-1', text: 'An answer.' });
      await expect(global.live.start('activation', 'instructions', new AbortController().signal)).rejects.toThrow(
        /another|legacy/i,
      );
      expect(
        (
          await session.fetch(
            post(VOICE_MEDIA_ROUTES.clientPlaybackResult, {
              ...client,
              playbackId: 'speech-1',
              outcome: 'completed',
            }),
          )
        ).status,
      ).toBe(204);
      const registration = {
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        leaseId: 'legacy-lease',
        revision: 1,
        label: 'Legacy',
        eligible: true,
        active: true,
      } as const;
      await session.syncOwnership({ registration, targets: [] });
      await expect(global.live.start('activation', 'instructions', new AbortController().signal)).rejects.toThrow(
        /another|legacy/i,
      );
      await session.syncOwnership({
        registration: { ...registration, active: false },
        handoff: {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          requestId: 'transfer',
          handle: 'target',
          catalogRevision: 'revision',
        },
        targets: [],
      });
      await expect(global.live.start('activation', 'instructions', new AbortController().signal)).rejects.toThrow(
        /another|legacy/i,
      );
      await session.syncOwnership({ registration: { ...registration, active: false }, targets: [] });
      await global.live.start('activation', 'instructions', new AbortController().signal);
      await expect(session.beginCapture('capture-1')).rejects.toThrow(/another|live/i);
      await global.live.stop('activation');
      await session.beginCapture('capture-1');
      session.close();
      await global.live.start('next-activation', 'instructions', new AbortController().signal);
    } finally {
      session.close();
      global.close();
    }
  });
});
