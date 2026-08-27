import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SNAPSHOT_BYTES, NodeSnapshotStoreAdapter } from '../../../src/adapters/node/snapshotStore.ts';

let directory: string;
let store: NodeSnapshotStoreAdapter;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-snapshots-'));
  store = new NodeSnapshotStoreAdapter();
  store.initialize(path.join(directory, 'blobs'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('NodeSnapshotStoreAdapter', () => {
  it('captures a file and reads it back by hash', async () => {
    const filePath = path.join(directory, 'a.ts');
    fs.writeFileSync(filePath, 'const value = 1;\n');
    const hash = await store.capture(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await store.read(hash as string)).toBe('const value = 1;\n');
  });

  it('stores identical content once, so an unchanged file costs nothing twice', async () => {
    const first = await store.put('same content');
    const second = await store.put('same content');
    expect(first).toBe(second);
    expect(fs.readdirSync(path.join(directory, 'blobs'))).toHaveLength(1);
  });

  it('answers nothing for a file that is not there', async () => {
    expect(await store.capture(path.join(directory, 'absent.ts'))).toBeUndefined();
  });

  it('refuses a binary file rather than storing bytes no diff can use', async () => {
    const filePath = path.join(directory, 'image.bin');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
    expect(await store.capture(filePath)).toBeUndefined();
  });

  it('refuses a file past the size cap', async () => {
    const filePath = path.join(directory, 'huge.txt');
    fs.writeFileSync(filePath, 'x'.repeat(MAX_SNAPSHOT_BYTES + 1));
    expect(await store.capture(filePath)).toBeUndefined();
  });

  it('answers nothing for a hash it never held, and for one that is not a hash', async () => {
    expect(await store.read('0'.repeat(64))).toBeUndefined();
    expect(await store.read('../../etc/passwd')).toBeUndefined();
  });

  it('removes everything it stored when the session ends', async () => {
    await store.put('content');
    await store.clear();
    expect(fs.existsSync(path.join(directory, 'blobs'))).toBe(false);
    // Clearing twice is what a shutdown after a failed start does.
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('refuses to work before it has been told where to store', async () => {
    const uninitialized = new NodeSnapshotStoreAdapter();
    await expect(uninitialized.put('content')).rejects.toThrow('not initialized');
  });
});
