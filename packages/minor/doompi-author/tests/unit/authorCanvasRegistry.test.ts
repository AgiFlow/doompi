import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAuthorBridgeState } from '../../src/models/authorBridgeState';
import { createAuthorCanvasRegistry } from '../../src/services/authorCanvasRegistry';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function bridge() {
  return createAuthorBridgeState({
    now: Date.now,
    issueToken: () => crypto.randomUUID(),
    scheduleTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
}

describe('conversation Author canvas registry', () => {
  it('reuses one canonical alias and root-relative path for alternate paths and symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-author-canvas-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'design.png'), 'image');
    await fs.symlink(path.join(root, 'docs', 'design.png'), path.join(root, 'shortcut.png'));
    const registry = createAuthorCanvasRegistry(root, bridge);
    const opened = await registry.open('docs/design.png', undefined, 'review');
    expect(opened).toMatchObject({ path: 'docs/design.png', alias: 'review', status: 'opening', reused: false });
    expect(await registry.open('shortcut.png', undefined, 'other')).toMatchObject({
      path: 'docs/design.png',
      alias: 'review',
      reused: true,
    });
    expect(await registry.open('docs/./design.png')).toMatchObject({ alias: 'review', reused: true });
    expect(registry.describe().canvases).toEqual([{ alias: 'review', path: 'docs/design.png', status: 'opening' }]);
    await expect(registry.open('docs/../shortcut.png', undefined, 'review')).resolves.toMatchObject({
      alias: 'review',
    });
    await fs.writeFile(path.join(root, 'another.png'), 'other');
    await expect(registry.open('another.png', undefined, 'review')).rejects.toThrow('already names');
    await expect(registry.open('../outside.png')).rejects.toThrow('outside');
    registry.dispose();
  });

  it('isolates same-named capabilities, tokens, and close across canvases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-author-canvas-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'a.png'), 'a');
    await fs.writeFile(path.join(root, 'b.png'), 'b');
    const registry = createAuthorCanvasRegistry(root, bridge);
    await registry.open('a.png', undefined, 'first');
    await registry.open('b.png', undefined, 'second');
    for (const alias of ['first', 'second']) {
      const owner = registry.bridge(alias).register('browser', 1);
      registry
        .bridge(alias)
        .catalog('browser', 1, owner.ownerToken, [
          { name: 'inspect', label: 'Inspect', description: 'Inspect', inputSchema: { type: 'object' } },
        ]);
    }
    const first = registry.describe('first');
    const second = registry.describe('second');
    expect(first.catalogToken).not.toBe(second.catalogToken);
    expect(first.tools.map((tool) => tool.name)).toEqual(['inspect']);
    expect(second.tools.map((tool) => tool.name)).toEqual(['inspect']);
    await expect(
      registry.invoke({ alias: 'second', catalogToken: first.catalogToken, name: 'inspect', arguments: {} }),
    ).rejects.toThrow('catalog changed');
    expect(registry.describe().catalogToken).toBe('');
    registry.close('first');
    expect(registry.describe('first').status).toBe('unavailable');
    expect(registry.describe('second').status).toBe('ready');
    expect(await registry.open('a.png', undefined, 'first')).toMatchObject({ status: 'opening', reused: true });
    registry.closeAll();
    expect(registry.describe().canvases).toEqual([
      { alias: 'first', path: 'a.png', status: 'unavailable' },
      { alias: 'second', path: 'b.png', status: 'unavailable' },
    ]);
    expect(() =>
      registry.invoke({ alias: 'second', catalogToken: second.catalogToken, name: 'inspect', arguments: {} }),
    ).toThrow('closed');
    registry.dispose();
  });
});
