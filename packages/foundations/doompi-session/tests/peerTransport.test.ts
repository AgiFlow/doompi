import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSessionPeerInbox } from '../src/services/peerInbox';
import { peerInboxApi } from '../src/services/peerInboxApi';
import {
  createPeerCommunication,
  peerRequestHeaders,
  readSessionPeerConfig,
  sessionPeerConfigPath,
  type SessionPeer,
} from '../src/services/peerTransport';

const directories: string[] = [];

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-peer-'));
  directories.push(directory);
  return directory;
}

function writeConfig(directory: string, value: unknown): void {
  const file = sessionPeerConfigPath(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

const peer: SessionPeer = {
  hostId: 'remote-host',
  url: 'https://remote.example.test/tunnel/',
  secret: 'peer-secret-with-at-least-thirty-two-characters',
  allowedSessionIds: ['target-session'],
};

function config(): object {
  return { version: 1, hostId: 'local-host', peers: [peer] };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('paired Session peer transport', () => {
  it('fails closed for malformed config and non-HTTPS tunnels', () => {
    const directory = home();
    writeConfig(directory, {
      version: 1,
      hostId: 'local-host',
      peers: [{ ...peer, url: 'http://remote.example.test' }],
    });
    expect(readSessionPeerConfig(directory)).toBeUndefined();
    writeConfig(directory, { version: 1, hostId: 'local-host', peers: [{ ...peer, allowedSessionIds: [] }] });
    expect(readSessionPeerConfig(directory)?.peers[0]?.allowedSessionIds).toEqual([]);
  });

  it('authenticates HMAC envelopes and enforces explicit target grants', async () => {
    const directory = home();
    writeConfig(directory, config());
    const api = peerInboxApi.start({ scope: 'global', homeDirectory: directory, onNotice: () => undefined });
    const received = vi.fn(() => 'accepted' as const);
    const unregister = registerSessionPeerInbox('target-session', received);
    const body = JSON.stringify({
      sourceSessionId: 'source-session',
      targetSessionId: 'target-session',
      type: 'doom/session-delivery/envelope',
      payload: { deliveryId: 'delivery-1' },
    });
    const request = new Request('http://doompi.local/inbox', {
      method: 'POST',
      headers: peerRequestHeaders('remote-host', peer, 'POST', '/inbox', body),
      body,
    });

    await expect(api.fetch(request)).resolves.toMatchObject({ status: 202 });
    expect(received).toHaveBeenCalledWith('peer/remote-host/source-session', 'doom/session-delivery/envelope', {
      deliveryId: 'delivery-1',
    });
    unregister();

    const forbiddenBody = JSON.stringify({ ...JSON.parse(body), targetSessionId: 'ungranted-session' });
    const forbidden = new Request('http://doompi.local/inbox', {
      method: 'POST',
      headers: peerRequestHeaders('remote-host', peer, 'POST', '/inbox', forbiddenBody),
      body: forbiddenBody,
    });
    expect((await api.fetch(forbidden)).status).toBe(403);
  });

  it('rejects tampered and expired peer requests', async () => {
    const directory = home();
    writeConfig(directory, config());
    const api = peerInboxApi.start({ scope: 'global', homeDirectory: directory, onNotice: () => undefined });
    const body = JSON.stringify({
      sourceSessionId: 'source-session',
      targetSessionId: 'target-session',
      type: 'doom/session-delivery/envelope',
      payload: {},
    });
    const headers = peerRequestHeaders('remote-host', peer, 'POST', '/inbox', body, Date.now() - 6 * 60_000);
    expect((await api.fetch(new Request('http://doompi.local/inbox', { method: 'POST', headers, body }))).status).toBe(
      401,
    );
    headers.set('x-doompi-session-signature', 'tampered');
    expect((await api.fetch(new Request('http://doompi.local/inbox', { method: 'POST', headers, body }))).status).toBe(
      401,
    );
  });

  it('posts remote references without treating an unknown host as local', async () => {
    const directory = home();
    writeConfig(directory, config());
    const local = {
      sessionId: 'source-session',
      publish: vi.fn(() => true),
      subscribe: vi.fn(() => () => undefined),
      onPeerReady: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const fetch = vi.fn<
      (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => Promise<Response>
    >(async () => new Response(null, { status: 202 }));
    const communication = createPeerCommunication({ local, homeDirectory: directory, fetch });

    expect(
      communication.publish('peer/remote-host/target-session', 'doom/session-delivery/envelope', { id: 'one' }),
    ).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [request] = fetch.mock.calls[0] ?? [];
    expect(request).toBeInstanceOf(URL);
    if (!(request instanceof URL)) throw new Error('Peer transport did not publish to a URL.');
    expect(request.href).toBe('https://remote.example.test/api/plugins/session-peer/inbox');
    expect(communication.publish('peer/missing/target-session', 'doom/session-delivery/envelope', {})).toBe(false);
    expect(local.publish).not.toHaveBeenCalled();
  });
});
