import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishSyncRegistration,
  readSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
  type SyncRegistration,
} from '../../src/adapters/syncRegistration';
import { resolveSyncLocation, syncGenerationDirectory } from '../../src/adapters/syncLocation';

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
    `${JSON.stringify({ name: '@agimon-ai/doompi', version, pi: { extensions: ['./dist/entries/doom.mjs'] } })}\n`,
  );
  return { root: fs.realpathSync(packageRoot), manifestPath: path.join(packageRoot, 'package.json'), entry, version };
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
    package: packageRecord,
  };
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

  it('rejects package entries outside the recorded package', () => {
    const home = temporaryDirectory();
    const packages = temporaryDirectory();
    const repoRoot = temporaryDirectory();
    const expected = registration(repoRoot, home, packages);
    expected.package.entry = expected.statePath;

    expect(() => publishSyncRegistration(repoRoot, expected, home)).toThrow('outside');
  });
});
