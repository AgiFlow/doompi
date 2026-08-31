import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundlePublication } from '../../src/adapters/bundlePublication.ts';

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
