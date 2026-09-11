import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFederationStore } from '../../src/adapters/federationStore.ts';
import { createFederationTransport } from '../../src/adapters/federationTransport.ts';
import { createFederationDirectory, federatedSessionId } from '../../src/adapters/federationDirectory.ts';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-directory-'));
  directories.push(directory);
  return createFederationStore(directory);
}

describe('enrolled peer directory', () => {
  it('coalesces discovery, respects outgoing grant direction and invalidates cached peer data', async () => {
    const local = store();
    const remote = store();
    const peer = { ...remote.identity(), name: 'peer', origin: 'https://peer.example', agentIds: [] };
    local.enroll(peer);
    remote.enroll({ ...local.identity(), name: 'local', origin: 'https://local.example', agentIds: ['allowed'] });
    const transport = createFederationTransport({
      store: remote,
      records: () => [
        {
          version: 1,
          id: 'allowed',
          name: 'Agent',
          cwd: '/private/project',
          socketPath: '/private/socket',
          tokenFile: '/private/token',
          pid: 123,
          createdAt: '2026-09-10T00:00:00Z',
        },
      ],
    });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const result = await transport.handle(JSON.parse(init?.body as string), undefined, init?.signal ?? undefined);
      return new Response(JSON.stringify(result.body), { status: result.status });
    });
    const changed = vi.fn();
    const directory = createFederationDirectory({ store: local, onNotice: vi.fn(), onChanged: changed });
    try {
      expect(directory.entries()).toEqual([]);
      const first = directory.refresh();
      expect(directory.refresh()).toBe(first);
      await first;
      const [entry] = directory.entries();
      expect(entry.agentId).toBe('allowed');
      expect(JSON.stringify(entry)).not.toContain('/private');
      expect(directory.summaries()[0].id).toBe(federatedSessionId(entry));
      await expect(directory.remote.resolve(federatedSessionId(entry))).resolves.toMatchObject({ cwd: '' });
      local.revoke(peer.hubId);
      directory.invalidate(peer.hubId);
      expect(directory.entries()).toEqual([]);
      expect(directory.summaries()).toEqual([]);
      expect(changed).toHaveBeenCalled();
      directory.close();
      await expect(directory.refresh()).rejects.toThrow('closed');
    } finally {
      directory.close();
      transport.close();
    }
  });
});
