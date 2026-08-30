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
  return { assetsDir, stateDir };
}

afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('signed bundle publication', () => {
  it('publishes a pinned key and a complete manifest containing the entry document', () => {
    const publication = createBundlePublication(fixture());
    expect(publication.trust()?.publicKey).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(publication.current()?.manifest.assets.map((asset) => asset.path)).toContain('/index.html');
  });

  it('advances the revision when sync replaces bundle bytes', () => {
    const paths = fixture();
    const publication = createBundlePublication(paths);
    const before = publication.current();
    fs.writeFileSync(path.join(paths.assetsDir, 'app.js'), 'console.log("two")');
    const after = publication.refresh();
    expect(after?.manifest.revision).toBe((before?.manifest.revision ?? 0) + 1);
    expect(after?.manifest.assets.find((asset) => asset.path === '/app.js')?.sha256).not.toBe(
      before?.manifest.assets.find((asset) => asset.path === '/app.js')?.sha256,
    );
  });

  it('refreshes before serving a bundle directory replaced by sync', () => {
    const paths = fixture();
    const publication = createBundlePublication(paths);
    const before = publication.current();
    const previousAssets = path.join(path.dirname(paths.assetsDir), 'previous-web');
    fs.renameSync(paths.assetsDir, previousAssets);
    fs.mkdirSync(paths.assetsDir);
    fs.writeFileSync(path.join(paths.assetsDir, 'index.html'), '<script src="/next.js"></script>');
    fs.writeFileSync(path.join(paths.assetsDir, 'next.js'), 'console.log("next")');

    const after = publication.current();

    expect(after?.manifest.revision).toBe((before?.manifest.revision ?? 0) + 1);
    expect(after?.manifest.assets.map((asset) => asset.path)).toContain('/next.js');
    expect(after?.manifest.assets.map((asset) => asset.path)).not.toContain('/app.js');
  });

  it('retains the last-known-good publication when refreshed traversal is unsafe', () => {
    const paths = fixture();
    const notices: string[] = [];
    const publication = createBundlePublication({ ...paths, onNotice: (message) => notices.push(message) });
    const before = publication.current();
    fs.symlinkSync(path.join(paths.assetsDir, 'app.js'), path.join(paths.assetsDir, 'linked.js'));
    expect(publication.refresh()).toEqual(before);
    expect(notices.some((message) => message.includes('refused'))).toBe(true);
  });
});
