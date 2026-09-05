import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHubChannels } from '../../src/adapters/webHubPluginLoader.ts';
import { SERVER_REGISTRY_FILE } from '../../src/adapters/webPluginGenerate.ts';

const directories: string[] = [];
function fixture(registry?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-channel-test-'));
  directories.push(root);
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets);
  if (registry !== undefined) fs.writeFileSync(path.join(assets, SERVER_REGISTRY_FILE), registry);
  return { root, assets };
}
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('hub plugin registry resilience', () => {
  it.each([undefined, '{}', '[{"pluginId":42},{"hubEntry":false}]'])(
    'ignores absent or non-channel registry data: %s',
    async (registry) => {
      const { assets } = fixture(registry);
      const notice = vi.fn();
      const baseline = await loadHubChannels(fixture().assets, notice);
      expect(await loadHubChannels(assets, notice)).toEqual(baseline);
      expect(notice).not.toHaveBeenCalled();
    },
  );

  it('reports unreadable JSON without losing built-in channels', async () => {
    const { assets } = fixture('{');
    const notice = vi.fn();
    const baseline = await loadHubChannels(fixture().assets, vi.fn());
    expect(await loadHubChannels(assets, notice)).toEqual(baseline);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('is unreadable'));
  });

  it('reports missing exports and non-Error import failures using fallback plugin identity', async () => {
    const { root, assets } = fixture();
    const missing = path.join(root, 'missing.mjs');
    const broken = path.join(root, 'broken.mjs');
    fs.writeFileSync(missing, 'export const other = [];');
    fs.writeFileSync(broken, 'throw "plugin refused";');
    fs.writeFileSync(
      path.join(assets, SERVER_REGISTRY_FILE),
      JSON.stringify([{ hubEntry: missing }, { pluginId: 'broken', hubEntry: broken }]),
    );
    const notice = vi.fn();
    await loadHubChannels(assets, notice);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/'unknown'.*exports no webHubChannels array/));
    expect(notice).toHaveBeenCalledWith(
      "web plugin 'broken' hub channels unavailable (plugin refused); its panels stay empty",
    );
  });

  it('loads the parent registry first and retains only the first channel for a frame type', async () => {
    const { root, assets } = fixture('[]');
    const entry = path.join(root, 'channels.mjs');
    fs.writeFileSync(
      entry,
      'export const webHubChannels = [{ frameType: "test-unique", name: "first" }, { frameType: "test-unique", name: "second" }];',
    );
    fs.writeFileSync(path.join(root, SERVER_REGISTRY_FILE), JSON.stringify([{ pluginId: 'test', hubEntry: entry }]));
    const notice = vi.fn();
    const channels = await loadHubChannels(assets, notice);
    expect(channels.filter((channel) => channel.frameType === 'test-unique')).toEqual([
      { frameType: 'test-unique', name: 'first' },
    ]);
    expect(notice).toHaveBeenCalledWith("duplicate web channel 'test-unique' dropped; frame types are global");
  });
});
