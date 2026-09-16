import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { packageResourcePath, readPackageResource } from '../../src/services/packageResource';

/**
 * A package layout whose bundled entry sits deeper than its source, which is the
 * shape that breaks a fixed-depth `new URL('../../..', import.meta.url)` walk.
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'doom-pkg-'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}');
  writeFileSync(path.join(root, 'llms.txt'), 'index body');
  mkdirSync(path.join(root, 'src/extensions/workspaces/sessions/(backend)/_lib'), { recursive: true });
  mkdirSync(path.join(root, 'dist/src/extensions/workspaces/sessions/(backend)/_lib'), { recursive: true });
  return {
    root,
    source: pathToFileURL(path.join(root, 'src/extensions/workspaces/sessions/(backend)/_lib/root.server.ts')),
    bundled: pathToFileURL(path.join(root, 'dist/src/extensions/workspaces/sessions/(backend)/_lib/root.server.mjs')),
  };
}

describe('packageResource', () => {
  it('resolves from the source tree and from the deeper bundled tree alike', async () => {
    const { root, source, bundled } = fixture();
    expect(packageResourcePath(source, 'llms.txt')).toBe(path.join(root, 'llms.txt'));
    // The case doompi-git's fixed-depth walk got wrong: dist/ adds a level.
    expect(packageResourcePath(bundled, 'llms.txt')).toBe(path.join(root, 'llms.txt'));
    expect(await readPackageResource(bundled, 'llms.txt')).toBe('index body');
  });

  it('degrades to empty text instead of a placeholder or a throw', async () => {
    const { bundled } = fixture();
    expect(packageResourcePath(bundled, 'README.md')).toBeUndefined();
    // '' is dropped by the prompt composer; '(resource unavailable: ...)' would be
    // pasted into the system prompt, and a throw would fail the whole build.
    await expect(readPackageResource(bundled, 'README.md')).resolves.toBe('');
  });
});
