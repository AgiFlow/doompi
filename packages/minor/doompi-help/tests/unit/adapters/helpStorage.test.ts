import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DefaultHelpSkillMaterializer,
  defaultHelpCacheRoot,
  HelpIndexCache,
  resolveHelpPackageIdentity,
  sha256Hex,
} from '../../../src/adapters/helpStorage.ts';
import type { ResolvedHelpIndex } from '../../../src/types/help.ts';

const SOURCE = '@agimon-ai/example-help';

function writePackage(root: string, version = '1.2.3'): string {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: SOURCE, version }));
  const modulePath = path.join(root, 'dist', 'extension.mjs');
  fs.writeFileSync(modulePath, 'export default () => {};\n');
  return modulePath;
}

describe('Help package identity and private storage', () => {
  let temporaryRoot: string;
  let packageRoot: string;
  let modulePath: string;
  let cacheRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-help-storage-'));
    packageRoot = path.join(temporaryRoot, 'package');
    modulePath = writePackage(packageRoot);
    packageRoot = fs.realpathSync(packageRoot);
    modulePath = fs.realpathSync(modulePath);
    cacheRoot = path.join(temporaryRoot, 'cache');
  });

  afterEach(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  it('derives package identity only from the nearest matching file module', () => {
    expect(resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE)).toEqual({
      source: SOURCE,
      version: '1.2.3',
      packageRoot,
      modulePath,
    });
    expect(() => resolveHelpPackageIdentity(pathToFileURL(modulePath).href, '@agimon-ai/wrong')).toThrowError(
      'does not match',
    );
    expect(() => resolveHelpPackageIdentity('https://example.com/extension.mjs', SOURCE)).toThrowError('must use file');
  });

  it('rejects package names that cannot form exact registry paths', () => {
    const unsafeSource = 'example/../escape';
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: unsafeSource, version: '1.2.3' }));

    expect(() => resolveHelpPackageIdentity(pathToFileURL(modulePath).href, unsafeSource)).toThrowError(
      'valid lowercase npm package name',
    );
  });

  it('rejects invalid versions, malformed manifests, directories, and orphan modules', () => {
    writePackage(packageRoot, '^1.2.3');
    expect(() => resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE)).toThrowError('exact semantic');

    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{');
    expect(() => resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE)).toThrowError('Cannot read');

    fs.writeFileSync(path.join(packageRoot, 'package.json'), '[]');
    expect(() => resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE)).toThrowError('must contain');

    fs.rmSync(path.join(packageRoot, 'package.json'));
    expect(() => resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE)).toThrowError('Cannot find');
    expect(() => resolveHelpPackageIdentity(pathToFileURL(packageRoot).href, SOURCE)).toThrowError(
      'not a regular file',
    );
  });

  it('publishes immutable verified cache entries and ignores partial or corrupt entries', () => {
    const identity = resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE);
    const cache = new HelpIndexCache(cacheRoot);
    const bytes = new TextEncoder().encode('# Example Help\n');
    const signal = new AbortController().signal;
    const published = cache.publish(identity, bytes, 'sha256-integrity', 'https://unpkg.com/pkg@1.2.3/', signal);

    expect(cache.read(identity)).toMatchObject({
      filePath: published.filePath,
      digest: sha256Hex(bytes),
      referenceBase: 'https://unpkg.com/pkg@1.2.3/',
    });
    expect(cache.publish(identity, bytes, 'ignored', 'ignored', signal)).toEqual(cache.read(identity));
    expect(fs.statSync(published.filePath).mode & 0o777).toBe(0o600);

    fs.writeFileSync(published.filePath, '# Corrupt\n');
    expect(cache.read(identity)).toBeUndefined();
    cache.discard(identity);
    expect(cache.read(identity)).toBeUndefined();
  });

  it('shares the completed winner of a concurrent publication race', () => {
    const identity = resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE);
    const cache = new HelpIndexCache(cacheRoot);
    const bytes = new TextEncoder().encode('# Example Help\n');
    const signal = new AbortController().signal;
    const renameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync');

    renameSpy.mockImplementationOnce((temporary, directory) => {
      renameSpy.mockRestore();
      cache.publish(identity, bytes, 'winner-integrity', 'https://unpkg.com/winner/', signal);
      renameSync(temporary, directory);
    });

    const published = cache.publish(identity, bytes, 'loser-integrity', 'https://unpkg.com/loser/', signal);

    expect(published).toMatchObject({
      integrity: 'winner-integrity',
      referenceBase: 'https://unpkg.com/winner/',
    });
    expect(cache.read(identity)).toEqual(published);
    expect(fs.readdirSync(cacheRoot)).toEqual([path.basename(cache.entryDirectory(identity))]);
  });

  it('does not publish when already aborted and uses the standard cache root', () => {
    const identity = resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE);
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      new HelpIndexCache(cacheRoot).publish(identity, new Uint8Array(), 'sri', 'base', controller.signal),
    ).toThrowError('cancelled');
    expect(defaultHelpCacheRoot('/home/test')).toBe(path.join('/home/test', '.pi', '.doom', 'llms-cache'));
  });

  it('materializes stable private SKILL.md wrappers and observes cancellation', async () => {
    const identity = resolveHelpPackageIdentity(pathToFileURL(modulePath).href, SOURCE);
    const index: ResolvedHelpIndex = {
      identity,
      location: 'local',
      filePath: path.join(packageRoot, 'llms.txt'),
      referenceBase: packageRoot,
      byteLength: 15,
      digest: 'index-digest',
    };
    const contribution = {
      source: SOURCE,
      moduleUrl: pathToFileURL(modulePath).href,
      skills: [{ name: 'example-help', description: 'Explain this package.' }],
    };
    const materializer = new DefaultHelpSkillMaterializer(cacheRoot);
    const signal = new AbortController().signal;
    const first = await materializer.materialize(contribution, index, signal);
    const second = await materializer.materialize(contribution, index, signal);

    expect(second).toEqual(first);
    expect(fs.readFileSync(first[0]!.filePath, 'utf8')).toContain('Explain this package.');
    expect(fs.statSync(first[0]!.filePath).mode & 0o777).toBe(0o600);

    const controller = new AbortController();
    controller.abort();
    await expect(materializer.materialize(contribution, index, controller.signal)).rejects.toThrowError('cancelled');
  });
});
