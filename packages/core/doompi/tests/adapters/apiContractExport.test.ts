import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalContractJson } from '@agimon-ai/doompi-core/api-contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { exportApiContracts } from '../../src/builders/apiContractExport';
import { runApiExport } from '../../src/cli/commands/api-export';

const fixture = vi.hoisted(() => ({ root: '', fresh: true }));
vi.mock('@agimon-ai/doompi-config/config', async (original) => ({
  ...(await original<object>()),
  globalDoomConfigDirectory: () => path.join(fixture.root, 'global'),
}));
vi.mock('@agimon-ai/doompi-config/majorModes', async (original) => ({
  ...(await original<object>()),
  loadMajorModesConfig: () => ({
    defaultMajorMode: 'default',
    majorMode: { default: { layers: [] }, alternate: { layers: ['optional'] } },
  }),
}));
vi.mock('@agimon-ai/doompi-core/sync-registration', () => ({
  readSyncRegistration: (root: string) => ({ serverBundle: { path: path.join(root, 'server.bundle.json') } }),
}));
vi.mock('../../src/composition/repository', () => ({
  resolveDoomConfigurationRoot: () => path.join(fixture.root, 'workspace'),
}));
vi.mock('../../src/composition/syncDrift', () => ({
  readSyncDrift: () => ({ fresh: fixture.fresh, reasons: fixture.fresh ? [] : ['changed'] }),
}));

function generation(name: string, missing = false) {
  const root = path.join(fixture.root, name);
  fs.mkdirSync(root, { recursive: true });
  const contract = {
    version: 1,
    dynamic: [],
    sockets: [],
    http: (['global', 'workspace', 'session'] as const).map((scope) => ({
      id: 'read',
      scope,
      basePath: name,
      path: '/read',
      method: 'GET',
      authentication: 'owner',
      description: 'Read fixture.',
      responses: { '200': { description: 'Fixture.', schema: { type: 'string' } } },
    })),
  };
  const bytes = canonicalContractJson({
    version: 1,
    generation: name,
    fingerprint: 'a'.repeat(64),
    packages: [
      {
        packageName: name,
        packageVersion: '1.2.3',
        scopes: ['global', 'workspace', 'session'],
        owners: [
          { majorMode: 'default', layer: 'default' },
          { majorMode: 'alternate', layer: 'optional' },
        ],
        ...(missing ? { problem: 'No contract declaration' } : { contract }),
      },
    ],
  });
  fs.writeFileSync(path.join(root, 'contracts.json'), bytes);
  fs.writeFileSync(
    path.join(root, 'server.bundle.json'),
    JSON.stringify({
      version: 2,
      generation: name,
      fingerprint: 'a'.repeat(64),
      entries: [],
      contracts: { file: './contracts.json', sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    }),
  );
}
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-api-export-'));
  fixture.fresh = true;
  generation('global');
  generation('workspace');
});
afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
const options = () => ({
  cwd: fixture.root,
  homeDirectory: fixture.root,
  outputDirectory: path.join(fixture.root, 'out'),
});

it('exports the global default, workspace default, and selected session mode with stable checksums', () => {
  const manifest = exportApiContracts({ ...options(), majorMode: 'alternate' });
  expect(manifest.complete).toBe(true);
  expect(manifest.selections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: 'global', generation: 'global', majorMode: 'default' }),
      expect.objectContaining({ scope: 'workspace', generation: 'workspace', majorMode: 'default' }),
      expect.objectContaining({ scope: 'session', generation: 'workspace', majorMode: 'alternate' }),
    ]),
  );
  const read = (name: string) => fs.readFileSync(path.join(options().outputDirectory, name), 'utf8');
  const first = read('manifest.json');
  const saved = JSON.parse(first) as { artifacts: Record<string, { sha256: string }> };
  for (const [name, entry] of Object.entries(saved.artifacts))
    expect(crypto.createHash('sha256').update(read(name)).digest('hex')).toBe(entry.sha256);
  exportApiContracts({ ...options(), majorMode: 'alternate' });
  expect(read('manifest.json')).toBe(first);
  const document = JSON.parse(read('openapi.json')) as { paths: Record<string, unknown> };
  expect(Object.keys(document.paths).sort()).toEqual([
    '/api/global/plugin/global/read',
    '/api/sessions/{sessionId}/plugin/workspace/read',
    '/api/workspaces/{workspaceId}/plugin/workspace/read',
  ]);
});

it('writes a reviewable incomplete bundle and fails strict mode', async () => {
  generation('workspace', true);
  const output = { write: vi.fn() };
  expect(
    await runApiExport(['api-export', '--out', 'out', '--strict'], { HOME: fixture.root }, fixture.root, output),
  ).toBe(1);
  expect(JSON.parse(fs.readFileSync(path.join(options().outputDirectory, 'manifest.json'), 'utf8'))).toMatchObject({
    complete: false,
    gaps: expect.arrayContaining([expect.objectContaining({ packageName: 'workspace' })]),
  });
  expect(await runApiExport(['api-export', '--out', 'out'], { HOME: fixture.root }, fixture.root, output)).toBe(0);
});

it('refuses stale, tampered, and unknown-mode input without starting services or publishing files', () => {
  fixture.fresh = false;
  expect(() => exportApiContracts(options())).toThrow('doompi sync');
  fixture.fresh = true;
  expect(() => exportApiContracts({ ...options(), majorMode: 'typo' })).toThrow('Unknown major mode');
  fs.appendFileSync(path.join(fixture.root, 'workspace', 'contracts.json'), ' ');
  expect(() => exportApiContracts(options())).toThrow('checksum mismatch');
  expect(fs.existsSync(options().outputDirectory)).toBe(false);
});

it('validates CLI options and serves help without a synced generation', async () => {
  fixture.fresh = false;
  const output = { write: vi.fn() };
  expect(await runApiExport(['api-export', '--help'], {}, fixture.root, output)).toBe(0);
  await expect(runApiExport(['api-export'], {}, fixture.root, output)).rejects.toThrow('--out');
  await expect(runApiExport(['api-export', '--out'], {}, fixture.root, output)).rejects.toThrow('requires a value');
  await expect(runApiExport(['api-export', '--unknown'], {}, fixture.root, output)).rejects.toThrow('Unknown');
});
