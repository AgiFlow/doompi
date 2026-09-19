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

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('loadMcpBundle', () => {
  it('loads only explicitly admitted and selected modules', async () => {
    const directory = fixture();
    const selected = await loadMcpBundle({
      directory,
      generation: 'generation',
      fingerprint,
      majorMode: 'coding',
      activeLayers: ['tools'],
    });
    const excluded = await loadMcpBundle({
      directory,
      generation: 'generation',
      fingerprint,
      majorMode: 'coding',
      activeLayers: [],
    });

    expect(selected.plugins.map(({ plugin }) => plugin.name)).toEqual(['demo']);
    expect(excluded.plugins).toEqual([]);
  });

  it('rejects a missing descriptor instead of falling back to local modules', async () => {
    const directory = fixture();
    fs.rmSync(path.join(directory, DOOM_MCP_BUNDLE_FILE));

    await expect(
      loadMcpBundle({ directory, generation: 'generation', fingerprint, majorMode: 'coding', activeLayers: [] }),
    ).rejects.toThrow();
  });

  it('rejects selected plugins whose admitted artifact changed', async () => {
    const directory = fixture();
    fs.appendFileSync(path.join(directory, 'modules', 'demo.mjs'), '\n// tampered');

    await expect(
      loadMcpBundle({
        directory,
        generation: 'generation',
        fingerprint,
        majorMode: 'coding',
        activeLayers: ['tools'],
      }),
    ).rejects.toThrow('module hash does not match the admitted descriptor');
  });

  it('fails closed when a selected admitted plugin cannot load', async () => {
    const directory = fixture('export default { name: "invalid" };');

    await expect(
      loadMcpBundle({
        directory,
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
    const notices: string[] = [];

    const loaded = await loadMcpBundle({
      directory,
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
