import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundlePublication, createPluginBundlePublication } from '../../src/adapters/bundlePublication.ts';

const cleanups: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-publication-'));
  cleanups.push(root);
  const assetsDir = path.join(root, 'web');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<script src="/app.js"></script>');
  fs.writeFileSync(path.join(assetsDir, 'app.js'), 'console.log("one")');
  return { assetsDir: () => assetsDir, stateDir, dir: assetsDir };
}

afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('signed bundle publication', () => {
  it('publishes a pinned key and a complete manifest containing the entry document', () => {
    const publication = createBundlePublication(fixture());
    expect(publication.trust()?.publicKey).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(publication.current()?.signed.manifest.assets.map((asset) => asset.path)).toContain('/index.html');
  });

  it('advances the revision when sync replaces bundle bytes', () => {
    const paths = fixture();
    const publication = createBundlePublication(paths);
    const before = publication.current();
    fs.writeFileSync(path.join(paths.dir, 'app.js'), 'console.log("two")');
    const after = publication.refresh();
    expect(after?.signed.manifest.revision).toBe((before?.signed.manifest.revision ?? 0) + 1);
    expect(after?.signed.manifest.assets.find((asset) => asset.path === '/app.js')?.sha256).not.toBe(
      before?.signed.manifest.assets.find((asset) => asset.path === '/app.js')?.sha256,
    );
  });

  it('refreshes before serving a bundle directory replaced by sync', () => {
    const paths = fixture();
    const publication = createBundlePublication(paths);
    const before = publication.current();
    const previousAssets = path.join(path.dirname(paths.dir), 'previous-web');
    fs.renameSync(paths.dir, previousAssets);
    fs.mkdirSync(paths.dir);
    fs.writeFileSync(path.join(paths.dir, 'index.html'), '<script src="/next.js"></script>');
    fs.writeFileSync(path.join(paths.dir, 'next.js'), 'console.log("next")');

    const after = publication.current();

    expect(after?.signed.manifest.revision).toBe((before?.signed.manifest.revision ?? 0) + 1);
    expect(after?.signed.manifest.assets.map((asset) => asset.path)).toContain('/next.js');
    expect(after?.signed.manifest.assets.map((asset) => asset.path)).not.toContain('/app.js');
  });

  it('names a republication of content already served at a lower revision', () => {
    const paths = fixture();
    const notices: string[] = [];
    const publication = createBundlePublication({ ...paths, onNotice: (message) => notices.push(message) });
    const original = fs.readFileSync(path.join(paths.dir, 'app.js'), 'utf8');
    fs.writeFileSync(path.join(paths.dir, 'app.js'), 'console.log("two")');
    publication.refresh();
    // Back to the bytes published first: what checking out an earlier commit
    // and syncing does. The revision still climbs, so the pairing floor lets it
    // through; the log is the only thing that can say a downgrade happened.
    fs.writeFileSync(path.join(paths.dir, 'app.js'), original);
    publication.refresh();

    expect(notices).toContainEqual(expect.stringMatching(/repeats content already published as revision \d+/u));
  });

  it('stays quiet when each publication carries new content', () => {
    const paths = fixture();
    const notices: string[] = [];
    const publication = createBundlePublication({ ...paths, onNotice: (message) => notices.push(message) });
    fs.writeFileSync(path.join(paths.dir, 'app.js'), 'console.log("two")');
    publication.refresh();
    fs.writeFileSync(path.join(paths.dir, 'app.js'), 'console.log("three")');
    publication.refresh();

    expect(notices.filter((message) => message.includes('repeats content'))).toHaveLength(0);
  });

  it('retains the last-known-good publication when refreshed traversal is unsafe', () => {
    const paths = fixture();
    const notices: string[] = [];
    const publication = createBundlePublication({ ...paths, onNotice: (message) => notices.push(message) });
    const before = publication.current();
    fs.symlinkSync(path.join(paths.dir, 'app.js'), path.join(paths.dir, 'linked.js'));
    expect(publication.refresh()).toEqual(before);
    expect(notices.some((message) => message.includes('refused'))).toBe(true);
  });
});

describe('signed plugin composition publication', () => {
  it('retains exact immutable identity and revision pairings', () => {
    const first = fixture();
    const second = fixture();
    const publication = createPluginBundlePublication(first.stateDir);

    const one = publication.publish('a'.repeat(64), first.dir);
    const two = publication.publish('b'.repeat(64), second.dir);
    const oneRevision = one?.signed.manifest.revision ?? 0;
    const twoRevision = two?.signed.manifest.revision ?? 0;
    const oneSnapshot = publication.get('a'.repeat(64), oneRevision)?.assetsDir;
    const twoSnapshot = publication.get('b'.repeat(64), twoRevision)?.assetsDir;

    expect(oneRevision).toBeGreaterThan(0);
    expect(twoRevision).toBe(oneRevision + 1);
    expect(oneSnapshot).not.toBe(first.dir);
    expect(twoSnapshot).not.toBe(second.dir);
    expect(publication.get('a'.repeat(64), twoRevision)).toBeUndefined();
    fs.writeFileSync(path.join(first.dir, 'app.js'), 'console.log("mutated")');
    expect(fs.readFileSync(path.join(oneSnapshot ?? '', 'app.js'), 'utf8')).toBe('console.log("one")');

    publication.close();
    expect(fs.existsSync(oneSnapshot ?? '')).toBe(false);
    expect(fs.existsSync(twoSnapshot ?? '')).toBe(false);
  });
  it('reuses an immutable composition identity and refuses publication after close', () => {
    const source = fixture();
    const publication = createPluginBundlePublication(source.stateDir);
    const compositionId = 'c'.repeat(64);
    const first = publication.publish(compositionId, source.dir);
    fs.writeFileSync(path.join(source.dir, 'app.js'), 'console.log("mutated")');

    expect(publication.publish(compositionId, source.dir)).toBe(first);
    expect(publication.publicKey()).toMatch(/^[A-Za-z0-9_-]+$/u);

    publication.close();
    expect(publication.publish('d'.repeat(64), source.dir)).toBeUndefined();
    publication.close();
  });

  it('reports and refuses a composition whose source directory is unavailable', () => {
    const source = fixture();
    const notices: string[] = [];
    const publication = createPluginBundlePublication(source.stateDir, (message) => notices.push(message));

    expect(publication.publish('e'.repeat(64), path.join(source.dir, 'missing'))).toBeUndefined();
    expect(notices).toContainEqual(expect.stringContaining('could not be signed'));
    publication.close();
  });

  it('refuses an empty composition without retaining its staging directory', () => {
    const source = fixture();
    const empty = path.join(path.dirname(source.dir), 'empty');
    fs.mkdirSync(empty);
    const notices: string[] = [];
    const publication = createPluginBundlePublication(source.stateDir, (message) => notices.push(message));

    expect(publication.publish('f'.repeat(64), empty)).toBeUndefined();
    expect(notices).toContainEqual(expect.stringContaining('empty and cannot be published'));
    publication.close();
  });

  it('evicts the oldest immutable composition after reaching the retention limit', () => {
    const source = fixture();
    const publication = createPluginBundlePublication(source.stateDir);
    const published = Array.from({ length: 33 }, (_, index) => {
      const compositionId = index.toString(16).padStart(64, '0');
      const bundle = publication.publish(compositionId, source.dir);
      expect(bundle).toBeDefined();
      return { compositionId, bundle };
    });
    const oldest = published[0];
    const newest = published.at(-1);

    expect(publication.get(oldest?.compositionId ?? '', oldest?.bundle?.signed.manifest.revision ?? 0)).toBeUndefined();
    expect(fs.existsSync(oldest?.bundle?.assetsDir ?? '')).toBe(false);
    expect(publication.get(newest?.compositionId ?? '', newest?.bundle?.signed.manifest.revision ?? 0)).toBe(
      newest?.bundle,
    );
    publication.close();
  });
});
