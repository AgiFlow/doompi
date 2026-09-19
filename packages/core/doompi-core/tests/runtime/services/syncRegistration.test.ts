import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DOOM_MCP_BUNDLE_FILE, DOOM_MCP_BUNDLE_VERSION } from '../../../src/schemas/mcpBundle';
import { resolveSyncLocation, syncGenerationDirectory } from '../../../src/services/syncLocation';
import {
  DOOMPI_API_VERSION,
  LEGACY_SYNC_REGISTRATION_VERSION,
  publishSyncRegistration,
  readSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
  type SyncRegistration,
} from '../../../src/services/syncRegistration';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sync-registration-')));
  temporaryDirectories.push(directory);
  return directory;
}

function packageFixture(
  root: string,
  version: string,
): { root: string; manifestPath: string; entry: string; version: string } {
  const packageRoot = path.join(root, `doompi-${version}`);
  const entry = path.join(packageRoot, 'dist', 'entries', 'doom.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'export default () => undefined;\n');
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: '@agimon-ai/doompi',
      version,
      doompiApiVersion: DOOMPI_API_VERSION,
      pi: { extensions: ['./dist/entries/doom.mjs'] },
    })}\n`,
  );
  return { root: fs.realpathSync(packageRoot), manifestPath: path.join(packageRoot, 'package.json'), entry, version };
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function registration(repoRoot: string, home: string, packageRoot: string): SyncRegistration {
  const location = resolveSyncLocation(repoRoot, home);
  const generation = 'generation-1';
  const generationRoot = syncGenerationDirectory(location, generation);
  const statePath = path.join(generationRoot, 'state.json');
  const webDirectory = path.join(generationRoot, 'web');
  const apiDirectory = path.join(generationRoot, 'api');
  fs.mkdirSync(webDirectory, { recursive: true });
  fs.mkdirSync(apiDirectory, { recursive: true });
  fs.writeFileSync(statePath, '{"state":true}\n');
  const packageRecord = packageFixture(packageRoot, path.basename(repoRoot));
  return {
    version: SYNC_REGISTRATION_VERSION,
    root: location.root,
    identity: location.identity,
    generation,
    generationRoot,
    statePath,
    stateSha256: syncStateSha256(statePath),
    webDirectory,
    apiDirectory,
    package: { ...packageRecord, apiVersion: DOOMPI_API_VERSION },
  };
}

function addMcpBundle(value: SyncRegistration): string {
  const directory = path.join(value.generationRoot, 'mcp');
  const modulePath = path.join(directory, 'modules', 'plugin.mjs');
  const descriptorPath = path.join(directory, DOOM_MCP_BUNDLE_FILE);
  const fingerprint = 'a'.repeat(64);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, 'export default { name: "plugin", session: { tools: [], skills: [] } };');
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      version: DOOM_MCP_BUNDLE_VERSION,
      generation: value.generation,
      fingerprint,
      entries: [
        {
          packageName: '@test/plugin',
          entry: './src/plugin.mcp.ts',
          module: './modules/plugin.mjs',
          sha256: sha256(modulePath),
          owners: [{ majorMode: 'coding', layer: 'default' }],
        },
      ],
    }),
  );
  fs.writeFileSync(value.statePath, JSON.stringify({ mcpBundle: { descriptorPath, fingerprint } }));
  value.stateSha256 = syncStateSha256(value.statePath);
  value.mcpBundle = { path: descriptorPath, fingerprint, sha256: sha256(descriptorPath) };
  return modulePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('sync registration', () => {
  it('publishes and reads the exact worktree registration', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);

    const recordPath = publishSyncRegistration(repoRoot, expected, home);

    expect(recordPath).toBe(resolveSyncLocation(repoRoot, home).registrationPath);
    expect(readSyncRegistration(repoRoot, home)).toEqual(expected);
  });

  it('accepts a compatible API after the producer npm version changes', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    const manifest = JSON.parse(fs.readFileSync(expected.package.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = 'new-release';
    manifest.doompiApiVersion = DOOMPI_API_VERSION;
    fs.writeFileSync(expected.package.manifestPath, `${JSON.stringify(manifest)}\n`);
    expected.package.version = 'old-release';
    expected.package.apiVersion = DOOMPI_API_VERSION;

    publishSyncRegistration(repoRoot, expected, home);

    expect(readSyncRegistration(repoRoot, home)).toEqual(expected);
  });

  it('accepts API metadata in a transitional legacy registration', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    expected.version = LEGACY_SYNC_REGISTRATION_VERSION;
    expected.package.version = 'old-release';
    const manifest = JSON.parse(fs.readFileSync(expected.package.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = 'new-release';
    fs.writeFileSync(expected.package.manifestPath, `${JSON.stringify(manifest)}\n`);

    publishSyncRegistration(repoRoot, expected, home);

    expect(readSyncRegistration(repoRoot, home)).toEqual(expected);
  });
  it('rejects an unsupported package API version', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    const manifest = JSON.parse(fs.readFileSync(expected.package.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.doompiApiVersion = DOOMPI_API_VERSION + 1;
    fs.writeFileSync(expected.package.manifestPath, `${JSON.stringify(manifest)}\n`);
    expected.package.apiVersion = DOOMPI_API_VERSION + 1;

    expect(() => publishSyncRegistration(repoRoot, expected, home)).toThrow('Unsupported DoomPi package API version');
  });
  it('keeps two repository registrations byte-isolated', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoA = temporaryDirectory();
    const repoB = temporaryDirectory();
    const recordA = registration(repoA, home, packages);
    const recordB = registration(repoB, home, packages);
    publishSyncRegistration(repoA, recordA, home);
    const pathB = publishSyncRegistration(repoB, recordB, home);
    const beforeB = fs.readFileSync(pathB);

    publishSyncRegistration(repoA, recordA, home);

    expect(fs.readFileSync(pathB)).toEqual(beforeB);
    expect(resolveSyncLocation(repoA, home).registrationPath).not.toBe(pathB);
  });

  it('fails closed when state changes after publication', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    publishSyncRegistration(repoRoot, expected, home);
    fs.writeFileSync(expected.statePath, '{"state":false}\n');

    expect(() => readSyncRegistration(repoRoot, home)).toThrow('mismatched state hash');
  });

  it('fails admission when an MCP artifact changes after publication', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    const modulePath = addMcpBundle(expected);
    publishSyncRegistration(repoRoot, expected, home);
    fs.appendFileSync(modulePath, '\n// tampered');

    expect(() => readSyncRegistration(repoRoot, home)).toThrow('mismatched MCP artifact hash');
  });

  it('rejects package entries outside the recorded package', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    expected.package.entry = expected.statePath;

    expect(() => publishSyncRegistration(repoRoot, expected, home)).toThrow('outside');
  });
  it('accepts a legacy registration only while its exact npm version remains installed', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    expected.version = LEGACY_SYNC_REGISTRATION_VERSION;
    delete expected.package.apiVersion;
    const manifest = JSON.parse(fs.readFileSync(expected.package.manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.doompiApiVersion;
    fs.writeFileSync(expected.package.manifestPath, `${JSON.stringify(manifest)}\n`);

    publishSyncRegistration(repoRoot, expected, home);

    expect(readSyncRegistration(repoRoot, home)).toEqual(expected);
    manifest.version = 'other-release';
    fs.writeFileSync(expected.package.manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => readSyncRegistration(repoRoot, home)).toThrow('does not match');
  });
});
