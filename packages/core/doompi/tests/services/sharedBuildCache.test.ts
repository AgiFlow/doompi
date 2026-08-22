import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contentSha256,
  findSharedBuild,
  materializeSharedBuild,
  publishSharedBuild,
  withSharedBuildLock,
} from '../../src/adapters/sharedBuildCache.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-shared-cache-'));
  temporaryDirectories.push(directory);
  return directory;
}

const digest = contentSha256;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('shared build cache', () => {
  it('publishes, verifies, resolves, and materializes one relocatable object', () => {
    const directory = temporaryDirectory();
    const cacheDirectory = path.join(directory, 'shared-cache');
    const sourcePath = path.join(directory, 'src', 'entry.mjs');
    const outputDirectory = path.join(directory, 'second-worktree', 'dist');
    const source = 'export default () => "__DOOMPI_PATH_0__";';
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, source);

    const lookupKey = digest('lookup');
    const token = '__DOOMPI_PATH_0__';
    const manifest = publishSharedBuild({
      cacheDirectory,
      lookupKey,
      entry: 'entry.mjs',
      inputs: [{ logicalPath: 'repo/src/entry.mjs', sha256: contentSha256(source), token }],
      artifacts: new Map([['entry.mjs', source]]),
    });

    const found = findSharedBuild(cacheDirectory, lookupKey, (input) =>
      input.logicalPath === 'repo/src/entry.mjs' ? sourcePath : undefined,
    );

    expect(found?.manifest.key).toBe(manifest.key);
    expect(materializeSharedBuild(found!, outputDirectory)).toBe(path.join(outputDirectory, 'entry.mjs'));
    expect(fs.readFileSync(path.join(outputDirectory, 'entry.mjs'), 'utf8')).toContain(sourcePath);
    expect(fs.statSync(path.join(cacheDirectory, 'objects', manifest.key, 'manifest.json')).mode & 0o777).toBe(0o600);
  });

  it('verifies external inputs from their canonical source path without assuming an installation layout', () => {
    const directory = temporaryDirectory();
    const cacheDirectory = path.join(directory, 'shared-cache');
    const sourcePath = path.join(directory, 'custom-runtime-location', 'dependency', 'entry.mjs');
    const source = 'export const value = true;';
    const token = '__DOOMPI_PATH_EXTERNAL__';
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, source);
    const lookupKey = digest('external-lookup');
    const manifest = publishSharedBuild({
      cacheDirectory,
      lookupKey,
      entry: 'entry.mjs',
      inputs: [
        {
          logicalPath: `external/${digest(sourcePath)}`,
          sha256: contentSha256(source),
          token,
          sourcePath,
        },
      ],
      artifacts: new Map([['entry.mjs', `export default ${JSON.stringify(token)};`]]),
    });
    let resolvedSourcePath: string | undefined;

    const found = findSharedBuild(cacheDirectory, lookupKey, (input) => {
      resolvedSourcePath = input.sourcePath;
      return input.sourcePath;
    });

    expect(found?.manifest.key).toBe(manifest.key);
    expect(resolvedSourcePath).toBe(sourcePath);
    expect(materializeSharedBuild(found!, path.join(directory, 'dist'))).toBe(
      path.join(directory, 'dist', 'entry.mjs'),
    );
    expect(fs.readFileSync(path.join(directory, 'dist', 'entry.mjs'), 'utf8')).toContain(sourcePath);

    fs.writeFileSync(sourcePath, 'export const value = false;');
    expect(findSharedBuild(cacheDirectory, lookupKey, (input) => input.sourcePath)).toBeUndefined();
  });

  it('rejects a shared object after an artifact is corrupted', () => {
    const directory = temporaryDirectory();
    const cacheDirectory = path.join(directory, 'shared-cache');
    const sourcePath = path.join(directory, 'entry.mjs');
    const source = 'export default () => true;';
    fs.writeFileSync(sourcePath, source);
    const lookupKey = digest('lookup');
    const manifest = publishSharedBuild({
      cacheDirectory,
      lookupKey,
      entry: 'entry.mjs',
      inputs: [{ logicalPath: 'repo/entry.mjs', sha256: contentSha256(source), token: '__TOKEN__' }],
      artifacts: new Map([['entry.mjs', source]]),
    });

    fs.writeFileSync(path.join(cacheDirectory, 'objects', manifest.key, 'entry.mjs'), 'tampered');

    expect(findSharedBuild(cacheDirectory, lookupKey, () => sourcePath)).toBeUndefined();
  });

  it('repairs a corrupt object when the same content is published again', () => {
    const directory = temporaryDirectory();
    const cacheDirectory = path.join(directory, 'shared-cache');
    const sourcePath = path.join(directory, 'entry.mjs');
    const source = 'export default () => true;';
    fs.writeFileSync(sourcePath, source);
    const lookupKey = digest('lookup');
    const options = {
      cacheDirectory,
      lookupKey,
      entry: 'entry.mjs',
      inputs: [{ logicalPath: 'repo/entry.mjs', sha256: contentSha256(source), token: '__TOKEN__' }],
      artifacts: new Map([['entry.mjs', source]]),
    };
    const manifest = publishSharedBuild(options);
    const artifact = path.join(cacheDirectory, 'objects', manifest.key, 'entry.mjs');
    fs.writeFileSync(artifact, 'tampered');

    expect(publishSharedBuild(options).key).toBe(manifest.key);
    expect(fs.readFileSync(artifact, 'utf8')).toBe(source);
    expect(findSharedBuild(cacheDirectory, lookupKey, () => sourcePath)?.manifest.key).toBe(manifest.key);
  });

  it('rejects traversal and non-CAS lookup keys before publication', () => {
    const directory = temporaryDirectory();
    const options = {
      cacheDirectory: path.join(directory, 'shared-cache'),
      entry: 'entry.mjs',
      inputs: [],
      artifacts: new Map<string, string>([['entry.mjs', 'export default () => undefined;']]),
    };

    expect(() => publishSharedBuild({ ...options, lookupKey: 'short' })).toThrow(/full SHA-256/u);
    expect(() =>
      publishSharedBuild({
        ...options,
        lookupKey: digest('relative-input'),
        inputs: [{ logicalPath: 'external/input', sha256: digest('source'), token: '', sourcePath: 'relative.mjs' }],
      }),
    ).toThrow(/source paths must be absolute/u);
    expect(() =>
      publishSharedBuild({ ...options, lookupKey: digest('lookup'), artifacts: new Map([['../escape.mjs', 'bad']]) }),
    ).toThrow(/escapes its object/u);
  });

  it('serializes concurrent publishers under one lookup lock', async () => {
    const directory = temporaryDirectory();
    const cacheDirectory = path.join(directory, 'shared-cache');
    const lookupKey = digest('lookup');
    const events: string[] = [];

    const first = withSharedBuildLock(cacheDirectory, lookupKey, async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('first:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = withSharedBuildLock(cacheDirectory, lookupKey, async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(fs.existsSync(path.join(cacheDirectory, 'locks', `${lookupKey}.lock`))).toBe(false);
  });
});
