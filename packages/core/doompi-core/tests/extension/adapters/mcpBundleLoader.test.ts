import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DOOM_MCP_BUNDLE_FILE, DOOM_MCP_BUNDLE_VERSION, loadMcpBundle } from '../../../src/exports/mcpFacet';

const created: string[] = [];
const fingerprint = 'a'.repeat(64);

function fixture(module = 'export default { name: "demo", session: { tools: [], skills: [] } };'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-mcp-bundle-'));
  created.push(directory);
  fs.mkdirSync(path.join(directory, 'modules'));
  const modulePath = path.join(directory, 'modules', 'demo.mjs');
  fs.writeFileSync(modulePath, module);
  fs.writeFileSync(
    path.join(directory, DOOM_MCP_BUNDLE_FILE),
    JSON.stringify({
      version: DOOM_MCP_BUNDLE_VERSION,
      generation: 'generation',
      fingerprint,
      entries: [
        {
          packageName: '@test/demo',
          entry: './generated/mcp.ts',
          module: './modules/demo.mjs',
          sha256: crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'),
          owners: [{ majorMode: 'coding', layer: 'tools' }],
        },
      ],
    }),
  );
  return directory;
}

function descriptorHash(directory: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(directory, DOOM_MCP_BUNDLE_FILE)))
    .digest('hex');
}

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('loadMcpBundle', () => {
  it('loads only explicitly admitted and selected modules', async () => {
    const directory = fixture();
    const descriptorSha256 = descriptorHash(directory);
    const selected = await loadMcpBundle({
      directory,
      descriptorSha256,
      generation: 'generation',
      fingerprint,
      majorMode: 'coding',
      activeLayers: ['tools'],
    });
    const excluded = await loadMcpBundle({
      directory,
      descriptorSha256,
      generation: 'generation',
      fingerprint,
      majorMode: 'coding',
      activeLayers: [],
    });

    expect(selected.plugins.map(({ plugin }) => plugin.name)).toEqual(['demo']);
    expect(excluded.plugins).toEqual([]);
  });

  it.each(['owners', 'module', 'whitespace', 'invalid JSON'])(
    'rejects %s descriptor tampering on a subsequent load',
    async (change) => {
      const directory = fixture();
      const options = {
        directory,
        descriptorSha256: descriptorHash(directory),
        generation: 'generation',
        fingerprint,
        majorMode: 'coding',
        activeLayers: [],
        retainCandidates: true,
      };
      await loadMcpBundle(options);
      const descriptorPath = path.join(directory, DOOM_MCP_BUNDLE_FILE);
      const original = fs.readFileSync(descriptorPath, 'utf8');
      if (change === 'owners') {
        fs.writeFileSync(descriptorPath, original.replace('"tools"', '"default"'));
      } else if (change === 'module') {
        const modulePath = path.join(directory, 'modules', 'replacement.mjs');
        fs.writeFileSync(modulePath, 'throw new Error("tampered module imported");');
        const replacementHash = crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
        const descriptor = JSON.parse(original);
        descriptor.entries[0].module = './modules/replacement.mjs';
        descriptor.entries[0].sha256 = replacementHash;
        fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
      } else {
        fs.writeFileSync(descriptorPath, change === 'whitespace' ? `${original}\n` : '{');
      }

      await expect(loadMcpBundle(options)).rejects.toThrow(
        'MCP descriptor hash does not match the admitted descriptor',
      );
    },
  );

  it('rejects a missing descriptor instead of falling back to local modules', async () => {
    const directory = fixture();
    const descriptorSha256 = descriptorHash(directory);
    fs.rmSync(path.join(directory, DOOM_MCP_BUNDLE_FILE));

    await expect(
      loadMcpBundle({
        directory,
        descriptorSha256,
        generation: 'generation',
        fingerprint,
        majorMode: 'coding',
        activeLayers: [],
      }),
    ).rejects.toThrow();
  });

  it('rejects selected plugins whose admitted artifact changed', async () => {
    const directory = fixture();
    const descriptorSha256 = descriptorHash(directory);
    fs.appendFileSync(path.join(directory, 'modules', 'demo.mjs'), '\n// tampered');

    await expect(
      loadMcpBundle({
        directory,
        descriptorSha256,
        generation: 'generation',
        fingerprint,
        majorMode: 'coding',
        activeLayers: ['tools'],
      }),
    ).rejects.toThrow('module hash does not match the admitted descriptor');
  });

  it('fails closed when a selected admitted plugin cannot load', async () => {
    const directory = fixture('export default { name: "invalid" };');
    const descriptorSha256 = descriptorHash(directory);

    await expect(
      loadMcpBundle({
        directory,
        descriptorSha256,
        generation: 'generation',
        fingerprint,
        majorMode: 'coding',
        activeLayers: ['tools'],
        retainCandidates: true,
      }),
    ).rejects.toThrow("MCP plugin '@test/demo' could not load");
  });

  it('may retain a failed unselected candidate without admitting it', async () => {
    const directory = fixture('export default { name: "invalid" };');
    const descriptorSha256 = descriptorHash(directory);
    const notices: string[] = [];

    const loaded = await loadMcpBundle({
      directory,
      descriptorSha256,
      generation: 'generation',
      fingerprint,
      majorMode: 'coding',
      activeLayers: [],
      retainCandidates: true,
      onNotice: (message) => notices.push(message),
    });

    expect(loaded.plugins).toEqual([]);
    expect(notices).toEqual([expect.stringContaining("MCP plugin '@test/demo' could not load")]);
  });
});

describe('composed MCP UI resources', () => {
  function withWidgets(widget = '@test/demo/read') {
    const directory = fixture(
      `export default { name: 'demo', session: { tools: [{ name: 'dynamic_read', label: 'Read', description: 'Read', parameters: { type: 'object' }, _meta: { 'doompi/widget': ${JSON.stringify(widget)} }, execute: async () => ({ content: [{ type: 'text', text: 'read output' }] }) }] } };`,
    );
    const descriptorPath = path.join(directory, DOOM_MCP_BUNDLE_FILE);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    const html = '<!doctype html><title>Composed tool widgets</title>';
    fs.writeFileSync(path.join(directory, 'widgets.html'), html);
    descriptor.ui = {
      file: './widgets.html',
      sha256: crypto.createHash('sha256').update(html).digest('hex'),
      inputs: [],
    };
    descriptor.entries[0].widgets = ['@test/demo/read'];
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    return {
      directory,
      descriptor,
      descriptorPath,
      html,
      options: {
        directory,
        descriptorSha256: descriptorHash(directory),
        generation: 'generation',
        fingerprint,
        majorMode: 'coding',
        activeLayers: ['tools'],
      },
    };
  }

  it('binds dynamic tool names to their package renderer without granting component tool access', async () => {
    const f = withWidgets();
    const loaded = await loadMcpBundle(f.options);
    const plugin = loaded.plugins[0]!.plugin;
    const scope = typeof plugin.session === 'function' ? await plugin.session({} as never) : plugin.session;
    const resource = scope.uiResources![0]!;
    expect(scope.uiResources).toHaveLength(1);
    expect(resource.uri).toBe(`ui://doompi/tools/${f.descriptor.ui.sha256}/index.html`);
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(await resource.read()).toBe(f.html);
    expect(resource._meta?.ui?.csp).toEqual({ connectDomains: [], resourceDomains: [] });
    expect(scope.tools?.[0]?._meta).toEqual({
      'doompi/widget': '@test/demo/read',
      ui: { resourceUri: resource.uri, visibility: ['model'] },
      'openai/outputTemplate': resource.uri,
    });
    expect(scope.tools?.[0]?.name).toBe('dynamic_read');
    expect(await scope.tools![0]!.execute('call', {}, undefined, undefined, {} as never)).toEqual({
      content: [{ type: 'text', text: 'read output' }],
    });
  });

  it('shares the exact immutable resource object between contributing packages', async () => {
    const f = withWidgets();
    const module = `export default { name: 'second', session: { tools: [{ name: 'write', _meta: { 'doompi/widget': '@test/second/write', ui: { visibility: ['model','app'] } } }] } };`;
    fs.writeFileSync(path.join(f.directory, 'modules', 'second.mjs'), module);
    f.descriptor.entries.push({
      ...f.descriptor.entries[0],
      packageName: '@test/second',
      module: './modules/second.mjs',
      sha256: crypto.createHash('sha256').update(module).digest('hex'),
      widgets: ['@test/second/write'],
    });
    fs.writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
    const loaded = await loadMcpBundle({ ...f.options, descriptorSha256: descriptorHash(f.directory) });
    const scopes = await Promise.all(
      loaded.plugins.map(({ plugin }) =>
        typeof plugin.session === 'function' ? plugin.session({} as never) : plugin.session,
      ),
    );
    expect(scopes[0]!.uiResources?.[0]).toBe(scopes[1]!.uiResources?.[0]);
    expect(scopes[1]!.tools?.[0]?._meta?.ui?.visibility).toEqual(['model', 'app']);
  });

  it('rejects widget keys owned by a different package', async () => {
    const f = withWidgets('@test/other/read');
    const plugin = (await loadMcpBundle(f.options)).plugins[0]!.plugin;
    expect(typeof plugin.session).toBe('function');
    if (typeof plugin.session === 'function')
      await expect(plugin.session({} as never)).rejects.toThrow('not owned by its package');
  });

  it('checks the composed HTML hash before loading a widget', async () => {
    const f = withWidgets();
    fs.appendFileSync(path.join(f.directory, 'widgets.html'), '\nchanged');
    await expect(loadMcpBundle(f.options)).rejects.toThrow('MCP UI hash');
  });

  it.each(['../widgets.html', './modules/../widgets.html', './widgets.js'])(
    'rejects invalid resource paths: %s',
    async (file) => {
      const f = withWidgets();
      f.descriptor.ui.file = file;
      fs.writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
      await expect(loadMcpBundle({ ...f.options, descriptorSha256: descriptorHash(f.directory) })).rejects.toThrow(
        'Invalid MCP',
      );
    },
  );

  it('requires a composed resource when the descriptor declares widgets', async () => {
    const f = withWidgets();
    delete f.descriptor.ui;
    fs.writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
    await expect(loadMcpBundle({ ...f.options, descriptorSha256: descriptorHash(f.directory) })).rejects.toThrow(
      'Missing composed MCP UI resource',
    );
  });
});
