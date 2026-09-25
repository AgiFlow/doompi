import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequestReceipts } from '@agimon-ai/doompi-core/history';
import type { DoomPeerAgentRegistry } from '@agimon-ai/doompi-core/packageApi';
import { peerRequestHeaders, sessionPeerConfigPath, type SessionPeer } from '@agimon-ai/doompi-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceMediaBroker } from '../src/services/clientMediaApi';
import { GlobalLiveCompanion } from '../src/services/globalLiveCompanion';
import type { GlobalLiveAgentHost, LiveAgentRoute } from '../src/services/globalLiveCompanion/type';
import { LiveAgentSession } from '../src/services/liveAgentSession';
import { registerVoicePeerAgent, requestPairedVoiceAgent, voicePeerRelayApi } from '../src/services/voicePeerRelay';

const directories: string[] = [];
function registry(): DoomPeerAgentRegistry {
  const agents = new Map<string, { fetch(request: Request): Promise<Response>; hubToken: string }>();
  return {
    register(sessionId, agent, hubToken) {
      if (agents.has(sessionId)) throw new Error(`Voice peer agent '${sessionId}' is already registered.`);
      const entry = { fetch: (request: Request) => agent.fetch(request), hubToken };
      agents.set(sessionId, entry);
      return () => {
        if (agents.get(sessionId) === entry) agents.delete(sessionId);
      };
    },
    get: (sessionId) => agents.get(sessionId),
  };
}
const peer: SessionPeer = {
  hostId: 'remote-host',
  url: 'https://remote.example.test/',
  secret: 'peer-secret-with-at-least-thirty-two-characters',
  allowedSessionIds: [],
  allowedVoiceSessionIds: ['agent-session'],
};
function home(hostId = 'local-host'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-agent-peer-'));
  directories.push(directory);
  const file = sessionPeerConfigPath(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      hostId,
      peers: [{ ...peer, hostId: hostId === 'local-host' ? 'remote-host' : 'local-host' }],
    }),
    { mode: 0o600 },
  );
  return directory;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('paired live agent relay', () => {
  it('routes only granted, signed agent requests with a host-local token and rejects replays', async () => {
    const directory = home('remote-host');
    const agent = new LiveAgentSession(
      'agent-session',
      'local-hub-token',
      vi.fn(async () => undefined),
    );
    const peerAgents = registry();
    const unregister = registerVoicePeerAgent(peerAgents, 'agent-session', agent, 'local-hub-token');
    expect(() => registerVoicePeerAgent(peerAgents, 'agent-session', agent, 'local-hub-token')).toThrow(
      'already registered',
    );
    const api = voicePeerRelayApi.start({
      scope: 'global',
      homeDirectory: directory,
      peerAgents,
      onNotice: () => undefined,
    });
    const signed = (value: object) => {
      const body = JSON.stringify({ ...value, nonce: randomUUID() });
      return new Request('http://doompi.local/peer-agent', {
        method: 'POST',
        headers: peerRequestHeaders('local-host', peer, 'POST', '/peer-agent', body),
        body,
      });
    };
    const readiness = { sessionId: 'agent-session', method: 'GET', path: '/live/agent', body: '' };
    const request = signed(readiness);
    const replay = request.clone();
    expect(await (await api.fetch(request)).json()).toMatchObject({
      available: true,
      sourceSessionId: 'agent-session',
    });
    expect((await api.fetch(replay)).status).toBe(401);
    expect(
      (
        await api.fetch(
          new Request('http://doompi.local/peer-agent', { method: 'POST', body: JSON.stringify(readiness) }),
        )
      ).status,
    ).toBe(401);
    expect((await api.fetch(signed({ ...readiness, sessionId: 'other' }))).status).toBe(403);
    expect((await api.fetch(signed({ ...readiness, path: '/live/control' }))).status).toBe(400);
    expect((await api.fetch(signed({ ...readiness, path: '/live/agent/admit' }))).status).toBe(400);
    expect((await api.fetch(signed({ ...readiness, path: '/live/agent', body: 'x'.repeat(130 * 1024) }))).status).toBe(
      413,
    );
    const prepared = await api.fetch(
      signed({
        ...readiness,
        method: 'POST',
        path: '/live/agent/prepare',
        body: JSON.stringify({ activationId: 'a', routeGeneration: 1, transactionId: 't' }),
      }),
    );
    expect(await prepared.json()).toMatchObject({ sourceSessionId: 'agent-session', routeGeneration: 1 });
    unregister();
    expect((await api.fetch(signed(readiness))).status).toBe(404);
    agent.close();
    api.close();
  });

  it('isolates identical session IDs across hosts while retaining signed grants and replay fences', async () => {
    const directory = home('remote-host');
    const secondDirectory = home('remote-host');
    const firstAgents = registry();
    const secondAgents = registry();
    const first = new LiveAgentSession(
      'agent-session',
      'first-token',
      vi.fn(async () => undefined),
    );
    const second = new LiveAgentSession(
      'agent-session',
      'second-token',
      vi.fn(async () => undefined),
    );
    const unregisterFirst = registerVoicePeerAgent(firstAgents, 'agent-session', first, 'first-token');
    const unregisterSecond = registerVoicePeerAgent(secondAgents, 'agent-session', second, 'second-token');
    const firstApi = voicePeerRelayApi.start({
      scope: 'global',
      homeDirectory: directory,
      peerAgents: firstAgents,
      onNotice: () => undefined,
    });
    const secondApi = voicePeerRelayApi.start({
      scope: 'global',
      homeDirectory: secondDirectory,
      peerAgents: secondAgents,
      onNotice: () => undefined,
    });
    const signed = (sessionId = 'agent-session') => {
      const body = JSON.stringify({ nonce: randomUUID(), sessionId, method: 'GET', path: '/live/agent', body: '' });
      return new Request('http://doompi.local/peer-agent', {
        method: 'POST',
        headers: peerRequestHeaders('local-host', peer, 'POST', '/peer-agent', body),
        body,
      });
    };
    try {
      const firstRequest = signed();
      const replay = firstRequest.clone();
      expect((await firstApi.fetch(firstRequest)).status).toBe(200);
      expect((await firstApi.fetch(replay)).status).toBe(401);
      expect((await secondApi.fetch(signed('other'))).status).toBe(403);
      expect((await secondApi.fetch(signed())).status).toBe(200);
      unregisterFirst();
      expect((await firstApi.fetch(signed())).status).toBe(404);
      expect(secondAgents.get('agent-session')).toBeDefined();
    } finally {
      unregisterFirst();
      unregisterSecond();
      first.close();
      second.close();
      firstApi.close();
      secondApi.close();
    }
  });

  it('rejects a signed native admission replay after its result was acknowledged', async () => {
    const directory = home('remote-host');
    const receipts = createRequestReceipts({ directory: path.join(directory, 'receipts') });
    const peerAgents = registry();
    const admit = vi.fn(async () => undefined);
    const agent = new LiveAgentSession('agent-session', 'token', admit);
    const unregister = registerVoicePeerAgent(peerAgents, 'agent-session', agent, 'token');
    const api = voicePeerRelayApi.start({
      scope: 'global',
      homeDirectory: directory,
      peerAgents,
      requestReceipts: receipts.receipts,
      onNotice: () => undefined,
    });
    const signed = (path: string, body: object) => {
      const payload = JSON.stringify({
        nonce: randomUUID(),
        sessionId: 'agent-session',
        method: 'POST',
        path,
        body: JSON.stringify(body),
      });
      return new Request('http://doompi.local/peer-agent', {
        method: 'POST',
        headers: peerRequestHeaders('local-host', peer, 'POST', '/peer-agent', payload),
        body: payload,
      });
    };
    try {
      const route = { activationId: 'activation', routeGeneration: 1, transactionId: 'transaction' };
      const prepared = await api.fetch(signed('/live/agent/prepare', route));
      const { sessionIncarnation } = (await prepared.json()) as { sessionIncarnation: string };
      const admission = {
        ...route,
        sessionIncarnation,
        requestId: 'provider-1',
        transcript: 'hello',
        intent: 'immediate',
      };
      expect((await api.fetch(signed('/live/agent/admit', admission))).status).toBe(200);
      agent.onRunStart({ runId: 'run-1' });
      agent.onSettled({ runId: 'run-1' });
      expect(
        (await api.fetch(signed('/live/agent/results/ack', { ...route, sessionIncarnation, cursor: 1 }))).status,
      ).toBe(204);
      expect((await api.fetch(signed('/live/agent/admit', admission))).status).toBe(409);
      expect(admit).toHaveBeenCalledOnce();
    } finally {
      unregister();
      agent.close();
      api.close();
      await receipts.close();
    }
  });

  it('checks outbound grants, bounds responses, and forwards no bearer credentials', async () => {
    const directory = home();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toBeInstanceOf(Headers);
      expect((init.headers as Headers).has('authorization')).toBe(false);
      return Response.json({ available: true, sourceSessionId: 'agent-session' });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(requestPairedVoiceAgent(directory, 'peer/remote-host/other', '/live/agent', 'GET')).rejects.toThrow(
      'not granted',
    );
    await expect(
      requestPairedVoiceAgent(directory, 'peer/remote-host/agent-session', '/live/control', 'GET'),
    ).rejects.toThrow('Invalid');
    const response = await requestPairedVoiceAgent(directory, 'peer/remote-host/agent-session', '/live/agent', 'GET');
    expect(await response.json()).toMatchObject({ sourceSessionId: 'agent-session' });
    expect(fetch).toHaveBeenCalledOnce();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(130 * 1024))),
    );
    expect(
      (await requestPairedVoiceAgent(directory, 'peer/remote-host/agent-session', '/live/agent', 'GET')).status,
    ).toBe(502);
  });
  it('routes local to paired and back through real signed agent adapters without restarting live media', async () => {
    const originHome = home();
    const destinationHome = home('remote-host');
    const originReceipts = createRequestReceipts({ directory: path.join(originHome, 'receipts') });
    const destinationReceipts = createRequestReceipts({ directory: path.join(destinationHome, 'receipts') });
    const peerAgents = registry();
    const nativeAdmission = vi.fn(async () => undefined);
    const local = new LiveAgentSession(
      'local-source',
      'origin-hub-token',
      vi.fn(async () => undefined),
    );
    const remote = new LiveAgentSession('agent-session', 'destination-hub-token', nativeAdmission);
    const unregister = registerVoicePeerAgent(peerAgents, 'agent-session', remote, 'destination-hub-token');
    const endpoint = voicePeerRelayApi.start({
      scope: 'global',
      homeDirectory: destinationHome,
      peerAgents,
      requestReceipts: destinationReceipts.receipts,
      onNotice: vi.fn(),
    });
    const relay = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.pathname).toBe('/api/plugins/voice/peer-agent');
      return endpoint.fetch(new Request('http://remote.local/peer-agent', init));
    });
    vi.stubGlobal('fetch', relay);
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const broker = {
      browserConnected: true,
      realtimeActive: true,
      close: vi.fn(),
      live: {
        start,
        stop,
        send: vi.fn(async () => undefined),
        control: vi.fn(async () => undefined),
        poll: vi.fn(async (activationId: string) => ({
          activationId,
          state: 'active' as const,
          cursor: 0,
          events: [],
          browser: { connection: 'connected' as const, listening: true, speaking: false, muted: false },
        })),
      },
    } as unknown as VoiceMediaBroker;
    const companion = new GlobalLiveCompanion({
      broker,
      receipts: originReceipts.receipts,
      homeDirectory: originHome,
      onNotice: vi.fn(),
    });
    companion.bind({
      sessions: () => [{ sessionId: 'local-source', cwd: '/work' }],
      onNotice: vi.fn(),
      requestSessionApi: async (
        scope: { sessionId: string },
        request: { path: string; method: string; body?: string },
      ) => {
        if (scope.sessionId !== 'local-source') return Response.json({ error: 'Not found.' }, { status: 404 });
        return local.fetch(
          new Request(`http://origin.local${request.path}`, {
            method: request.method,
            headers: { authorization: 'Bearer origin-hub-token' },
            ...(request.body === undefined ? {} : { body: request.body }),
          }),
        );
      },
    } as GlobalLiveAgentHost);
    try {
      await companion.activate('local-source');
      await vi.waitFor(() => expect(companion.status.state).toBe('active'));
      expect(await companion.handoff('local-source', 'peer/remote-host/agent-session', 'transfer-1')).toBe(true);
      expect(companion.status.activeSessionId).toBe('peer/remote-host/agent-session');
      const internal = companion as unknown as {
        admit(requestId: string, text: string): Promise<string>;
        pollAgentResults(route: LiveAgentRoute): Promise<boolean>;
        route: LiveAgentRoute;
      };
      expect(await internal.admit('provider-1', 'Talk to the paired Pi agent')).toBe('submitted');
      remote.onRunStart({ runId: 'remote-run' });
      remote.onTurnEnd({
        runId: 'remote-run',
        turnId: 'turn-1',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Paired answer.' }],
        },
      });
      remote.onSettled({ runId: 'remote-run' });
      expect(await internal.pollAgentResults(internal.route)).toBe(false);
      expect(nativeAdmission).toHaveBeenCalledExactlyOnceWith('Talk to the paired Pi agent');
      expect(await companion.handoff('peer/remote-host/agent-session', 'local-source', 'transfer-2')).toBe(true);
      expect(companion.status.activeSessionId).toBe('local-source');
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(relay).toHaveBeenCalled();
    } finally {
      await companion.close();
      endpoint.close();
      unregister();
      local.close();
      remote.close();
      await originReceipts.close();
      await destinationReceipts.close();
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
