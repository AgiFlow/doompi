import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFederationStore } from '../../src/adapters/federationStore.ts';
import { registerFederationRoutes } from '../../src/adapters/federationRoutes.ts';
import { projectAgentCatalog } from '../../src/services/agentCatalog.ts';
import type { SessionRecord } from '../../src/types/registry.ts';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-federation-routes-'));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const record: SessionRecord = {
  version: 1,
  id: 's1',
  name: 'Agent',
  cwd: '/private/work/project',
  socketPath: '/private/socket',
  apiSocketPath: '/private/api',
  protocolSocketPath: '/private/protocol',
  protocolServerId: 'local-server',
  tokenFile: '/private/token',
  pid: 87654321,
  createdAt: '2026-09-10T00:00:00.000Z',
  serverComposition: {
    root: '/private/root',
    apiDirectory: '/private/bundle',
    generation: 'secret-generation',
    fingerprint: 'secret-fingerprint',
    majorMode: 'copilot',
    activeLayers: [],
  },
};

it('projects only named catalog fields and exact local grants', () => {
  expect(projectAgentCatalog('hub', [record])).toEqual({
    version: 1,
    hubId: 'hub',
    agents: [
      {
        version: 1,
        hubId: 'hub',
        agentId: 's1',
        name: 'Agent',
        project: 'project',
        createdAt: record.createdAt,
        status: 'live',
      },
    ],
  });
  expect(projectAgentCatalog('hub', [record], []).agents).toEqual([]);
  expect(projectAgentCatalog('hub', [record], ['peer/s1']).agents).toEqual([]);
  expect(projectAgentCatalog('hub', [record], ['s1']).agents).toHaveLength(1);
});

it('keeps enrollment, identity and revocation host-local, independent of device authentication', async () => {
  const app = new Hono();
  registerFederationRoutes(app, {
    store: createFederationStore(directory),
    records: () => [record],
    isLocal: () => false,
    onNotice: () => {},
  });
  for (const [method, route] of [
    ['GET', '/api/federation/identity'],
    ['GET', '/api/federation/peers'],
    ['POST', '/api/federation/peers'],
    ['DELETE', '/api/federation/peers/some-peer'],
  ]) {
    expect((await app.request(route!, { method })).status).toBe(403);
  }
  expect(fs.readdirSync(directory)).toEqual([]);
});

it('serves a non-cacheable catalog and saves enrollment only after fingerprint confirmation', async () => {
  const app = new Hono();
  const store = createFederationStore(directory);
  const notices: string[] = [];
  registerFederationRoutes(app, {
    store,
    records: () => [record],
    isLocal: () => true,
    onNotice: (notice) => notices.push(notice),
  });
  const catalog = await app.request('/api/agents');
  expect(catalog.headers.get('cache-control')).toBe('no-store');
  expect(await catalog.json()).toEqual(projectAgentCatalog(store.identity().hubId, [record]));
  const identity = createFederationStore(path.join(directory, 'peer')).identity();
  const body = { ...identity, origin: 'https://peer.example', name: 'Peer', agentIds: ['s1'] };
  const enroll = () =>
    app.request('/api/federation/peers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await enroll()).status).toBe(201);
  expect((await enroll()).status).toBe(409);
  expect(notices).toHaveLength(1);
  expect((await app.request(`/api/federation/peers/${identity.hubId}`, { method: 'DELETE' })).status).toBe(200);
  expect(store.peers()).toEqual([]);
});
