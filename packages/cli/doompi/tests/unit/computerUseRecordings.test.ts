import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoomComputerUseSessionAccess, DoomDirectEventBus } from '@agimon-ai/doompi-core/hubChannel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerUseRecordingStore } from '../../src/builders/server/computerUseRecordings';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-recording-test-'));
  directories.push(root);
  const staging = path.join(root, 'staging');
  const grant = path.join(staging, 'grant');
  await fs.mkdir(grant, { recursive: true, mode: 0o700 });
  await fs.chmod(staging, 0o700);
  const source = path.join(grant, 'recording.mp4');
  await fs.writeFile(source, 'movie bytes', { mode: 0o600 });
  const store = new ComputerUseRecordingStore(path.join(root, 'recordings'), staging);
  const receipt = {
    stopped: true,
    artifact: { kind: 'screen_recording', path: source, contentType: 'video/mp4', audioScope: 'target_application' },
  };
  return { root, source, store, receipt, staging, grant };
}

describe('native recording storage', () => {
  it('delivers an imported IPC receipt through the broker and authorized artifact route', async () => {
    const { store, receipt } = await fixture();
    const stopped = (await store.importStop('session', 'grant', receipt)) as {
      artifact: { artifactId: string; sizeBytes: number };
    };
    // Load the peer implementation at runtime so this boundary test does not
    // include another package's sources in the CLI TypeScript project.
    const peerUrl = new URL(
      '../../../../minor/doompi-computer-use/src/services/computerUseApi/index.ts',
      import.meta.url,
    ).href;
    const { createComputerUseApi } = (await import(peerUrl)) as {
      createComputerUseApi(options: {
        sessionId: string;
        hubToken: string;
        directEvents: DoomDirectEventBus;
        desktop: DoomComputerUseSessionAccess;
      }): { fetch(request: Request): Promise<Response>; state(): { artifact?: unknown }; close(): void };
    };
    const broker = createComputerUseApi({
      sessionId: 'session',
      hubToken: 'hub',
      directEvents: { publish() {}, subscribe: () => () => undefined, close() {} },
      desktop: {
        available: true,
        authorize: (headers) => headers.get('x-doompi-desktop') === 'proof',
        claim() {},
        subscribe: () => () => undefined,
        fetchRecording: (id, range) => store.read('session', id, range),
      },
    });
    await broker.fetch(
      new Request('http://host/hub/stop', {
        method: 'POST',
        headers: { authorization: 'Bearer hub' },
        body: JSON.stringify({ artifact: stopped.artifact }),
      }),
    );
    expect(broker.state().artifact).toMatchObject(stopped.artifact);
    await broker.fetch(
      new Request('http://host/hub/stop', { method: 'POST', headers: { authorization: 'Bearer hub' }, body: '{}' }),
    );
    expect(broker.state().artifact).toMatchObject(stopped.artifact);
    const url = `http://host/artifact?artifactId=${stopped.artifact.artifactId}&offset=0`;
    expect((await broker.fetch(new Request(url))).status).toBe(404);
    const response = await broker.fetch(new Request(url, { headers: { 'x-doompi-desktop': 'proof' } }));
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('movie bytes');
    expect(
      (
        await broker.fetch(
          new Request(url.replace('offset=0', 'offset=-1'), { headers: { 'x-doompi-desktop': 'proof' } }),
        )
      ).status,
    ).toBe(400);
    await store.close();
    broker.close();
  });
  it('imports native-shaped receipts once and reads only bounded session-owned bytes', async () => {
    const { store, receipt, source } = await fixture();
    const stopped = (await store.importStop('session', 'grant', receipt)) as {
      artifact: { artifactId: string; sizeBytes: number; status: string };
    };
    expect(stopped.artifact).toMatchObject({ sizeBytes: 11, status: 'ready' });
    expect(JSON.stringify(stopped)).not.toContain(source);
    expect(await store.importStop('session', 'grant', receipt)).toEqual(stopped);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    const response = await store.read('session', stopped.artifact.artifactId, 'bytes=0-1048575');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-10/11');
    expect(await response.text()).toBe('movie bytes');
    expect((await store.read('other', stopped.artifact.artifactId, 'bytes=0-1')).status).toBe(404);
    expect((await store.read('session', stopped.artifact.artifactId, 'bytes=0-1048576')).status).toBe(416);
    await store.close();
    expect((await store.read('session', stopped.artifact.artifactId, 'bytes=0-1')).status).toBe(404);
  });

  it('does not retain an import racing session closure, including during the atomic rename', async () => {
    const { store, receipt, root } = await fixture();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      await store.forgetSession('session');
      return rename(source, destination);
    });
    await expect(store.importStop('session', 'grant', receipt)).rejects.toThrow('Native recording import failed.');
    expect(await fs.readdir(path.join(root, 'recordings'))).toEqual([]);
    await store.close();
  });

  it('expires recordings after retention and removes their stored bytes', async () => {
    const { store, receipt, root } = await fixture();
    const stopped = (await store.importStop('session', 'grant', receipt)) as { artifact: { artifactId: string } };
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    expect((await store.read('session', stopped.artifact.artifactId, 'bytes=0-1')).status).toBe(404);
    expect(await fs.readdir(path.join(root, 'recordings'))).toEqual([]);
    await store.close();
  });

  it('evicts the oldest recording at the count quota and shares concurrent imports', async () => {
    const { store, receipt, staging, root } = await fixture();
    const first = (await Promise.all([
      store.importStop('session', 'grant', receipt),
      store.importStop('session', 'grant', receipt),
    ])) as { artifact: { artifactId: string } }[];
    expect(first[0]).toEqual(first[1]);
    for (let index = 1; index <= 8; index++) {
      const grantId = `grant-${index}`;
      const directory = path.join(staging, grantId);
      await fs.mkdir(directory, { mode: 0o700 });
      const source = path.join(directory, 'recording.mp4');
      await fs.writeFile(source, 'movie bytes', { mode: 0o600 });
      await store.importStop('session', grantId, {
        ...receipt,
        artifact: { ...receipt.artifact, path: source },
      });
    }
    expect((await store.read('session', first[0]!.artifact.artifactId, 'bytes=0-1')).status).toBe(404);
    expect(await fs.readdir(path.join(root, 'recordings'))).toHaveLength(8);
    await store.close();
  });

  it('returns unavailable rather than throwing if a stored recording disappears', async () => {
    const { store, receipt, root } = await fixture();
    const stopped = (await store.importStop('session', 'grant', receipt)) as { artifact: { artifactId: string } };
    await fs.unlink(path.join(root, 'recordings', `${stopped.artifact.artifactId}.mp4`));
    expect((await store.read('session', stopped.artifact.artifactId, 'bytes=0-1')).status).toBe(410);
    await store.close();
  });

  it.each(['path', 'symlink', 'directory', 'size', 'permissions'])(
    'rejects invalid %s without disclosing paths',
    async (attack) => {
      const { store, receipt, source, root, grant } = await fixture();
      if (attack === 'path') receipt.artifact.path = path.join(root, 'foreign.mp4');
      if (attack === 'symlink') {
        await fs.unlink(source);
        await fs.symlink(path.join(root, 'foreign.mp4'), source);
      }
      if (attack === 'directory') {
        await fs.unlink(source);
        await fs.mkdir(source);
      }
      if (attack === 'size') await fs.truncate(source, 128 * 1024 * 1024 + 1);
      if (attack === 'permissions') await fs.chmod(grant, 0o755);
      await expect(store.importStop('session', 'grant', receipt)).rejects.toThrow('Native recording import failed.');
    },
  );
});
