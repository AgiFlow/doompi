import { describe, expect, it, vi } from 'vitest';

import type { VoiceMediaBroker } from '../src/services/clientMediaApi';
import { GlobalLiveCompanion } from '../src/services/globalLiveCompanion';
import type { GlobalLiveAgentHost, GlobalLiveReceipts, LiveAgentRoute } from '../src/services/globalLiveCompanion/type';
import { LiveAgentSession } from '../src/services/liveAgentSession';

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}

describe('global live companion and native agent route', () => {
  it('fences A to B to A without restarting the host provider or browser media', async () => {
    const scopes = [
      { sessionId: 'source', cwd: '/work/source' },
      { sessionId: 'target', cwd: '/work/target' },
    ];
    const agents = new Map(
      scopes.map((scope) => [
        scope.sessionId,
        new LiveAgentSession(
          scope.sessionId,
          'hub-secret',
          vi.fn(async () => undefined),
        ),
      ]),
    );
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const broker = {
      browserConnected: true,
      realtimeActive: true,
      live: {
        start,
        stop,
        poll: vi.fn(async (activationId: string) => ({
          activationId,
          state: 'active' as const,
          cursor: 0,
          events: [],
          browser: { connection: 'connected' as const, listening: true, speaking: false, muted: false },
        })),
        send: vi.fn(async () => undefined),
        control: vi.fn(async () => undefined),
      },
      close: vi.fn(),
    } as unknown as VoiceMediaBroker;
    const receipts = {
      reserve: vi.fn(async () => ({ kind: 'reserved' as const, token: 'token' })),
      finish: vi.fn(async () => ({ outcome: 'admitted' as const })),
    } satisfies GlobalLiveReceipts;
    const notices = vi.fn();
    const companion = new GlobalLiveCompanion({ broker, receipts, onNotice: notices });
    const host = {
      sessions: () => scopes,
      onNotice: notices,
      requestSessionApi: async (
        scope: { sessionId: string },
        request: { path: string; method: string; body?: string },
      ) => {
        const agent = agents.get(scope.sessionId);
        if (!agent) return Response.json({ error: 'Not found.' }, { status: 404 });
        return agent.fetch(
          new Request(`http://voice.test${request.path}`, {
            method: request.method,
            headers: { authorization: 'Bearer hub-secret' },
            ...(request.body === undefined ? {} : { body: request.body }),
          }),
        );
      },
    } as GlobalLiveAgentHost;
    await expect(companion.activate('source')).rejects.toThrow('not available on this host');
    companion.bind(host);
    try {
      await expect(companion.activate('unknown')).rejects.toThrow('not available on this host');
      await companion.activate('source');
      await eventually(() => expect(companion.status.state).toBe('active'));
      expect(companion.status.activeSessionId).toBe('source');
      expect(companion.mediaReady()).toBe(true);
      await companion.activate('source');
      await expect(companion.activate('target')).rejects.toThrow('prepared Voice transfer');
      const native = companion as unknown as {
        route: LiveAgentRoute;
        admit(requestId: string, transcript: string): Promise<string>;
        pollAgentResults(route: LiveAgentRoute): Promise<boolean>;
      };
      expect(await native.admit('provider-1', 'Ask the Pi agent')).toBe('submitted');
      const sourceAgent = agents.get('source')!;
      sourceAgent.onRunStart({ runId: 'native-run-1' });
      sourceAgent.onTurnEnd({
        runId: 'native-run-1',
        turnId: 'turn-1',
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Pi answered.' }] },
      });
      sourceAgent.onSettled({ runId: 'native-run-1' });
      expect(await native.pollAgentResults(native.route)).toBe(false);
      expect(receipts.finish).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'voice.publication', outcome: 'admitted' }),
      );
      expect(broker.live.send).toHaveBeenCalled();
      const api = companion.api.start({ scope: 'global', onNotice: notices });
      const transfer = api.fetch(
        new Request('http://voice.test/live/control', {
          method: 'POST',
          body: JSON.stringify({ action: 'transfer', sessionId: 'target' }),
        }),
      );
      const transferred = await transfer;
      expect(transferred.status).toBe(200);
      expect(await transferred.json()).toMatchObject({ activeSessionId: 'target' });
      expect((await companion.control({ action: 'transfer', sessionId: 'target' })).activeSessionId).toBe('target');
      expect(await companion.handoff('source', 'target', 'stale')).toBe(false);
      const invalid = await api.fetch(
        new Request('http://voice.test/live/control', {
          method: 'POST',
          body: JSON.stringify({ action: 'transfer', sessionId: 'unknown' }),
        }),
      );
      expect(invalid.status).toBe(409);
      expect(companion.status.activeSessionId).toBe('target');
      const back = await api.fetch(
        new Request('http://voice.test/live/control', {
          method: 'POST',
          body: JSON.stringify({ action: 'transfer', sessionId: 'source' }),
        }),
      );
      expect(back.status).toBe(200);
      expect(companion.status.activeSessionId).toBe('source');
      expect(companion.status.error).toBeUndefined();
      api.close();
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await companion.close();
      for (const agent of agents.values()) agent.close();
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
