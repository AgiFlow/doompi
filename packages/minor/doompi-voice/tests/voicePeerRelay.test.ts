import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { peerRequestHeaders, sessionPeerConfigPath, type SessionPeer } from '@agimon-ai/doompi-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverPairedVoiceTargets,
  registerVoicePeerBroker,
  registerVoicePeerOwnership,
  sendPairedVoiceOwnershipCommand,
  voicePeerRelayApi,
} from '../src/services/voicePeerRelay';
import {
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipCommand,
} from '../src/types/voiceOwnership';

const directories: string[] = [];
const peer: SessionPeer = {
  hostId: 'remote-host',
  url: 'https://remote.example.test/',
  secret: 'peer-secret-with-at-least-thirty-two-characters',
  allowedSessionIds: [],
  allowedVoiceSessionIds: ['voice-session'],
};

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-voice-peer-'));
  directories.push(directory);
  const file = sessionPeerConfigPath(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, hostId: 'local-host', peers: [peer] }), { mode: 0o600 });
  return directory;
}

function relayBody(pathname = '/client/connect'): string {
  return JSON.stringify({
    targetSessionId: 'voice-session',
    method: 'POST',
    path: pathname,
    headers: [['content-type', 'application/json']],
    body: Buffer.from(JSON.stringify({ connectionId: 'connection' })).toString('base64'),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('paired Voice relay', () => {
  it('admits only HMAC-authenticated, explicitly granted client media routes', async () => {
    const directory = home();
    const fetch = vi.fn(async (request: Request) =>
      Response.json(
        { path: new URL(request.url).pathname },
        {
          headers: {
            'x-doompi-playback-state': 'sealed',
            'x-doompi-voice-event': '1',
            'x-private': 'discarded',
          },
        },
      ),
    );
    const broker = { fetch, close: () => undefined };
    const unregister = registerVoicePeerBroker('voice-session', broker);
    expect(() => registerVoicePeerBroker('voice-session', broker)).toThrow('already registered');
    const api = voicePeerRelayApi.start({ scope: 'global', homeDirectory: directory, onNotice: () => undefined });
    const body = relayBody();
    const request = new Request('http://doompi.local/peer', {
      method: 'POST',
      headers: peerRequestHeaders('remote-host', peer, 'POST', '/peer', body),
      body,
    });

    const response = await api.fetch(request);
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as { status: number; headers: Array<[string, string]>; body: string };
    expect(envelope.status).toBe(200);
    expect(envelope.headers).toContainEqual(['x-doompi-playback-state', 'sealed']);
    expect(envelope.headers).toContainEqual(['x-doompi-voice-event', '1']);
    expect(envelope.headers.some(([name]) => name === 'x-private')).toBe(false);
    expect(JSON.parse(Buffer.from(envelope.body, 'base64').toString('utf8'))).toEqual({ path: '/client/connect' });
    expect(fetch).toHaveBeenCalledOnce();

    const replay = await api.fetch(
      new Request('http://doompi.local/peer', {
        method: 'POST',
        headers: request.headers,
        body,
      }),
    );
    expect(replay.status).toBe(401);
    expect(fetch).toHaveBeenCalledOnce();

    const privileged = relayBody('/host/ownership/sync');
    expect(
      (
        await api.fetch(
          new Request('http://doompi.local/peer', {
            method: 'POST',
            headers: peerRequestHeaders('remote-host', peer, 'POST', '/peer', privileged),
            body: privileged,
          }),
        )
      ).status,
    ).toBe(400);
    unregister();
    unregister();
    api.close();
  });

  it('requires trusted caller identity and binds opaque handles to the controller and granted target', async () => {
    const directory = home();
    const api = voicePeerRelayApi.start({ scope: 'global', homeDirectory: directory, onNotice: () => undefined });
    const body = relayBody();
    expect(
      (
        await api.fetch(
          new Request('http://doompi.local/relay-binding', {
            method: 'POST',
            body: JSON.stringify({ target: 'peer/remote-host/voice-session', connectionId: 'connection' }),
          }),
        )
      ).status,
    ).toBe(401);

    const headers = new Headers({
      'x-doompi-api-caller-locality': 'local',
      'x-doompi-api-caller-step-up': 'not-required',
      'content-type': 'application/json',
    });
    expect(
      (
        await api.fetch(
          new Request('http://doompi.local/relay-binding', {
            method: 'POST',
            headers,
            body: JSON.stringify({ target: 'peer/remote-host/not-granted', connectionId: 'connection' }),
          }),
        )
      ).status,
    ).toBe(403);

    const issued = await api.fetch(
      new Request('http://doompi.local/relay-binding', {
        method: 'POST',
        headers,
        body: JSON.stringify({ target: 'peer/remote-host/voice-session', connectionId: 'connection' }),
      }),
    );
    expect(issued.status).toBe(200);
    const binding = ((await issued.json()) as { binding: string }).binding;
    const otherDevice = new Headers({
      'x-doompi-api-caller-locality': 'remote',
      'x-doompi-api-caller-device-id': 'other-device',
      'x-doompi-api-caller-step-up': 'verified',
    });
    expect(
      (
        await api.fetch(
          new Request(`http://doompi.local/relay?binding=${binding}`, { method: 'POST', headers: otherDevice, body }),
        )
      ).status,
    ).toBe(403);
    const mismatched = relayBody().replace(
      Buffer.from(JSON.stringify({ connectionId: 'connection' })).toString('base64'),
      Buffer.from(JSON.stringify({ connectionId: 'other' })).toString('base64'),
    );
    expect(
      (
        await api.fetch(
          new Request(`http://doompi.local/relay?binding=${binding}`, { method: 'POST', headers, body: mismatched }),
        )
      ).status,
    ).toBe(400);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 204, headers: [], body: '' })),
    );
    expect(
      (await api.fetch(new Request(`http://doompi.local/relay?binding=${binding}`, { method: 'POST', headers, body })))
        .status,
    ).toBe(200);
    const getBody = JSON.stringify({
      targetSessionId: 'voice-session',
      method: 'GET',
      path: '/client/events?connectionId=connection',
      headers: [],
      body: '',
    });
    expect(
      (
        await api.fetch(
          new Request(`http://doompi.local/relay?binding=${binding}`, { method: 'POST', headers, body: getBody }),
        )
      ).status,
    ).toBe(200);
    const realtimeBody = (activationId: string) =>
      JSON.stringify({
        targetSessionId: 'voice-session',
        method: 'POST',
        path: '/client/realtime/state',
        headers: [['content-type', 'application/json']],
        body: Buffer.from(JSON.stringify({ connectionId: 'connection', activationId })).toString('base64'),
      });
    expect(
      (
        await api.fetch(
          new Request(`http://doompi.local/relay?binding=${binding}`, {
            method: 'POST',
            headers,
            body: realtimeBody('activation-a'),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api.fetch(
          new Request(`http://doompi.local/relay?binding=${binding}`, {
            method: 'POST',
            headers,
            body: realtimeBody('activation-b'),
          }),
        )
      ).status,
    ).toBe(403);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('peer offline');
      }),
    );
    expect(
      (await api.fetch(new Request(`http://doompi.local/relay?binding=${binding}`, { method: 'POST', headers, body })))
        .status,
    ).toBe(503);

    expect(
      (await api.fetch(new Request('http://doompi.local/relay-binding', { method: 'POST', headers, body: '{invalid' })))
        .status,
    ).toBe(400);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect(
      (await api.fetch(new Request(`http://doompi.local/relay?binding=${binding}`, { method: 'POST', headers, body })))
        .status,
    ).toBe(403);
    clock.mockRestore();
    api.close();
  });

  it('bounds opaque media bindings and prunes the oldest handle', async () => {
    const directory = home();
    const api = voicePeerRelayApi.start({ scope: 'global', homeDirectory: directory, onNotice: () => undefined });
    const headers = new Headers({
      'x-doompi-api-caller-locality': 'local',
      'x-doompi-api-caller-step-up': 'not-required',
      'content-type': 'application/json',
    });
    const issued: string[] = [];
    for (let index = 0; index < 513; index += 1) {
      const response = await api.fetch(
        new Request('http://doompi.local/relay-binding', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            target: 'peer/remote-host/voice-session',
            connectionId: `connection-${String(index)}`,
          }),
        }),
      );
      issued.push(((await response.json()) as { binding: string }).binding);
    }
    expect(
      (
        await api.fetch(
          new Request(`http://doompi.local/relay?binding=${issued[0]!}`, {
            method: 'POST',
            headers,
            body: relayBody(),
          }),
        )
      ).status,
    ).toBe(403);
    api.close();
  });

  it('discovers granted remote targets and stages commands without forwarding context or caller stamps', async () => {
    const directory = home();
    const delivered: VoiceOwnershipCommand[] = [];
    const unregister = registerVoicePeerOwnership({
      discover: () => [
        {
          sessionId: 'voice-session',
          registration: {
            version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
            leaseId: 'lease-remote',
            revision: 4,
            label: 'Remote target',
            eligible: true,
            active: false,
          },
        },
        {
          sessionId: 'not-granted',
          registration: {
            version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
            leaseId: 'lease-hidden',
            revision: 1,
            label: 'Hidden target',
            eligible: true,
            active: false,
          },
        },
      ],
      async command(_sessionId, command) {
        delivered.push(command);
        return {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          commandId: command.commandId,
          action: command.action,
          ok: true,
          active: false,
        };
      },
    });
    const api = voicePeerRelayApi.start({ scope: 'global', homeDirectory: directory, onNotice: () => undefined });
    const signed = (body: string) =>
      new Request('http://doompi.local/peer-ownership', {
        method: 'POST',
        headers: peerRequestHeaders('remote-host', peer, 'POST', '/peer-ownership', body),
        body,
      });
    const discoverBody = JSON.stringify({ operation: 'discover' });
    const discovered = await api.fetch(signed(discoverBody));
    expect(discovered.status).toBe(200);
    await expect(discovered.json()).resolves.toMatchObject({
      targets: [{ sessionId: 'voice-session', registration: { label: 'Remote target' } }],
    });

    const staged: VoiceOwnershipCommand = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'prepare-remote',
      action: 'prepare',
      handoffId: 'handoff-remote',
      controllerId: 'forged-controller',
      leaseId: 'lease-remote',
      revision: 4,
    };
    const commandBody = JSON.stringify({ operation: 'command', sessionId: 'voice-session', command: staged });
    expect((await api.fetch(signed(commandBody))).status).toBe(200);
    expect(delivered).toEqual([{ ...staged, controllerId: 'peer:remote-host:forged-controller' }]);
    expect(JSON.stringify(delivered)).not.toContain('context');
    const forbiddenBody = JSON.stringify({ operation: 'command', sessionId: 'not-granted', command: staged });
    expect((await api.fetch(signed(forbiddenBody))).status).toBe(403);
    const unstagedBody = JSON.stringify({
      operation: 'command',
      sessionId: 'voice-session',
      command: {
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: 'unstaged-activate',
        action: 'activate',
      },
    });
    expect((await api.fetch(signed(unstagedBody))).status).toBe(400);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON ownership body.');
        const body = JSON.parse(init.body) as { operation: string; command?: VoiceOwnershipCommand };
        if (body.operation === 'discover')
          return Response.json({
            targets: [
              {
                sessionId: 'voice-session',
                registration: {
                  version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
                  leaseId: 'lease-remote',
                  revision: 4,
                  label: 'Remote target',
                  eligible: true,
                  active: false,
                },
              },
            ],
          });
        const command = body.command!;
        return Response.json({
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          commandId: command.commandId,
          action: command.action,
          ok: true,
          active: false,
        } satisfies VoiceOwnershipAcknowledgement);
      }),
    );
    await expect(discoverPairedVoiceTargets()).resolves.toEqual([
      {
        sessionId: 'peer/remote-host/voice-session',
        registration: expect.objectContaining({ leaseId: 'lease-remote' }),
      },
    ]);
    await expect(sendPairedVoiceOwnershipCommand('peer/remote-host/voice-session', staged)).resolves.toMatchObject({
      commandId: 'prepare-remote',
      ok: true,
    });
    await expect(sendPairedVoiceOwnershipCommand('invalid-target', staged)).rejects.toThrow(
      'Paired Voice target is invalid.',
    );

    unregister();
    api.close();
  });

  it('fails closed when the home host has no peer configuration context', async () => {
    const api = voicePeerRelayApi.start({ scope: 'global', onNotice: () => undefined });
    const headers = new Headers({
      'x-doompi-api-caller-locality': 'local',
      'x-doompi-api-caller-step-up': 'not-required',
    });
    expect(
      (await api.fetch(new Request('http://doompi.local/relay-binding', { method: 'POST', headers, body: '{}' })))
        .status,
    ).toBe(503);
    expect(
      (
        await api.fetch(
          new Request('http://doompi.local/relay?binding=missing', { method: 'POST', headers, body: '{}' }),
        )
      ).status,
    ).toBe(503);
    expect((await api.fetch(new Request('http://doompi.local/unknown'))).status).toBe(404);
    api.close();
  });
});
