import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeTreeManifestAdapter } from '../../../src/adapters/node/treeManifest.ts';

let root: string;

function write(relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-manifest-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NodeTreeManifestAdapter', () => {
  it('notices a file a script rewrote without ever naming it', async () => {
    const manifests = new NodeTreeManifestAdapter();
    const target = write('src/app.ts', 'before');
    write('src/other.ts', 'untouched');
    const before = await manifests.take(root);
    fs.writeFileSync(target, 'after, and longer');
    expect(manifests.changed(before, await manifests.take(root))).toEqual([target]);
  });

  it('notices a file that appeared and one that vanished', async () => {
    const manifests = new NodeTreeManifestAdapter();
    const removed = write('gone.txt', 'here');
    const before = await manifests.take(root);
    fs.rmSync(removed);
    const added = write('new.txt', 'fresh');
    expect(manifests.changed(before, await manifests.take(root))).toEqual([removed, added].sort());
  });

  it('reports nothing when the tree did not move', async () => {
    const manifests = new NodeTreeManifestAdapter();
    write('a.txt', 'stable');
    const before = await manifests.take(root);
    expect(manifests.changed(before, await manifests.take(root))).toEqual([]);
  });

  it('skips the directories a build fills, so output is never an edit', async () => {
    const manifests = new NodeTreeManifestAdapter();
    write('node_modules/pkg/index.js', 'dependency');
    write('dist/bundle.js', 'output');
    write('.git/HEAD', 'ref: refs/heads/main');
    const kept = write('src/app.ts', 'source');
    const manifest = await manifests.take(root);
    expect([...manifest.entries.keys()]).toEqual([kept]);
  });

  it('skips the paths a caller excludes, which is how the package hides its own storage', async () => {
    const manifests = new NodeTreeManifestAdapter();
    const timeline = write('timeline.jsonl', '{}');
    const blob = write('timeline.blobs/abc', 'snapshot');
    const source = write('app.ts', 'source');
    const manifest = await manifests.take(root, [timeline, path.join(root, 'timeline.blobs')]);
    expect([...manifest.entries.keys()]).toEqual([source]);
    expect([...manifest.entries.keys()]).not.toContain(blob);
  });

  it('stops at the entry cap and says the manifest is partial', async () => {
    const manifests = new NodeTreeManifestAdapter({ maxEntries: 3 });
    for (let index = 0; index < 10; index += 1) write(`file-${index}.txt`, 'content');
    const manifest = await manifests.take(root);
    expect(manifest.entries.size).toBeLessThanOrEqual(3);
    expect(manifest.truncated).toBe(true);
  });

  it('stops at the depth cap and says the manifest is partial', async () => {
    const manifests = new NodeTreeManifestAdapter({ maxDepth: 1 });
    write('shallow.txt', 'seen');
    write('one/two/three/deep.txt', 'unseen');
    const manifest = await manifests.take(root);
    expect(manifest.truncated).toBe(true);
    expect([...manifest.entries.keys()].some((entry) => entry.endsWith('deep.txt'))).toBe(false);
  });

  it('never follows a symlink, so a loop cannot hang the walk', async () => {
    const manifests = new NodeTreeManifestAdapter();
    write('real.txt', 'content');
    fs.symlinkSync(root, path.join(root, 'loop'), 'dir');
    const manifest = await manifests.take(root);
    expect([...manifest.entries.keys()]).toEqual([path.join(root, 'real.txt')]);
  });

  it('fingerprints one file in the same vocabulary a walk records', async () => {
    const manifests = new NodeTreeManifestAdapter();
    const filePath = write('a.txt', 'content');
    const manifest = await manifests.take(root);
    expect(await manifests.fingerprint(filePath)).toBe(manifest.entries.get(filePath));
    expect(await manifests.fingerprint(path.join(root, 'absent.txt'))).toBeUndefined();
  });

  it('reads back when one file was last written, and nothing for what is not a file', async () => {
    const manifests = new NodeTreeManifestAdapter();
    const filePath = write('a.txt', 'content');
    fs.utimesSync(filePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(await manifests.modifiedAt(filePath)).toBe(1_700_000_000_000);
    expect(await manifests.modifiedAt(path.join(root, 'absent.txt'))).toBeUndefined();
    expect(await manifests.modifiedAt(root)).toBeUndefined();
  });
  it('answers an empty manifest for a directory that is not there', async () => {
    const manifests = new NodeTreeManifestAdapter();
    const manifest = await manifests.take(path.join(root, 'absent'));
    expect(manifest.entries.size).toBe(0);
    expect(manifest.truncated).toBe(false);
  });
});
