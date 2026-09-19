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
