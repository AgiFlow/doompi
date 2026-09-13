import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { voiceClientSettingsApi } from '../src/controllers/voiceClientSettingsApi';
import { VoiceClientSettingsStore } from '../src/services/voiceClientSettings';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('server Voice microphone preferences', () => {
  it('persists per-browser selection across server restarts and clears it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-settings-'));
    roots.push(home);
    const file = join(home, '.pi', '.doom', 'voice', 'clients.json');
    const store = new VoiceClientSettingsStore(file);
    const input = { deviceId: 'physical', groupId: 'group', label: 'Built-in' };
    store.register('browser-one', [input]);
    await expect(store.select('browser-one', 'unknown')).rejects.toThrow('Register');
    await store.select('browser-one', input.deviceId);
    const restored = new VoiceClientSettingsStore(file);
    expect(await restored.read('browser-one')).toEqual({ inputs: [], deviceId: 'physical' });
    expect(await restored.read('browser-two')).toEqual({ inputs: [], deviceId: null });
    await restored.select('browser-one', null);
    expect((await store.read('browser-one')).deviceId).toBeNull();
  });
  it('serializes concurrent saves without losing another browser preference', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-settings-'));
    roots.push(home);
    const store = new VoiceClientSettingsStore(join(home, 'clients.json'));
    for (const client of ['one', 'two']) store.register(client, [{ deviceId: client, groupId: '', label: client }]);
    await Promise.all(['one', 'two'].map((client) => store.select(client, client)));
    expect((await store.read('one')).deviceId).toBe('one');
    expect((await store.read('two')).deviceId).toBe('two');
  });
});

it('validates physical input registration and persists selection through the public settings API', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voice-settings-api-'));
  roots.push(home);
  const context = { homeDirectory: home, environment: {} } as Parameters<typeof voiceClientSettingsApi.start>[0];
  const api = voiceClientSettingsApi.start(context);
  const send = (path: string, method: string, body?: unknown) =>
    api.fetch(
      new Request(`http://voice${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  try {
    expect((await send('/clients/browser', 'GET')).status).toBe(200);
    expect((await send('/clients/browser', 'PUT', { deviceId: 'unregistered' })).status).toBe(400);
    const input = { deviceId: 'physical', groupId: 'built-in', label: 'Microphone' };
    expect((await send('/clients/browser/inputs', 'PUT', { inputs: [{ ...input, deviceId: 'default' }] })).status).toBe(
      400,
    );
    expect((await send('/clients/browser/inputs', 'PUT', { inputs: [input] })).status).toBe(200);
    expect(await (await send('/clients/browser', 'PUT', { deviceId: 'physical' })).json()).toEqual({
      inputs: [input],
      deviceId: 'physical',
    });
    const restarted = voiceClientSettingsApi.start(context);
    try {
      expect(await (await restarted.fetch(new Request('http://voice/clients/browser'))).json()).toEqual({
        inputs: [],
        deviceId: 'physical',
      });
    } finally {
      restarted.close();
    }
    expect(await (await send('/clients/browser', 'DELETE')).json()).toMatchObject({ deviceId: null });
    expect((await send('/clients/browser', 'POST', {})).status).toBe(405);
    expect((await send('/clients/browser', 'PUT', null)).status).toBe(400);
    expect((await send('/clients/browser', 'PUT', {})).status).toBe(400);
    expect((await send('/missing', 'GET')).status).toBe(404);
  } finally {
    api.close();
  }
});
