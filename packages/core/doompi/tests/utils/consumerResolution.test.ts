import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumerPackageEntries,
  consumerPackageEntry,
  localPackageName,
} from '../../src/exports/utils/moduleResolution';

/**
 * Consumer resolution against synthetic packages.
 *
 * The exports shapes a real repository can present are wide (plain strings,
 * condition maps, arrays, and packages with no exports at all), so they are
 * built here rather than borrowed from whatever happens to be installed.
 */
describe('consumerPackageEntry', () => {
  let consumerRoot: string;

  beforeEach(() => {
    consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-consumer-'));
    fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({ name: 'consumer' }));
  });

  afterEach(() => {
    fs.rmSync(consumerRoot, { recursive: true, force: true });
  });

  function writePackage(packageRoot: string, manifest: unknown, files: string[]): string {
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
    for (const file of files) {
      const target = path.join(packageRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    }
    return packageRoot;
  }

  function install(name: string, manifest: unknown, files: string[] = []): string {
    return writePackage(path.join(consumerRoot, 'node_modules', ...name.split('/')), manifest, files);
  }

  function installManaged(name: string, manifest: unknown, files: string[] = []): string {
    return writePackage(path.join(consumerRoot, '.pi', 'npm', 'node_modules', ...name.split('/')), manifest, files);
  }

  it('resolves a subpath declared as a plain string', () => {
    const root = install('@scope/plain', { exports: { './extensions/pi': './dist/pi.mjs' } }, ['dist/pi.mjs']);

    expect(consumerPackageEntry('@scope/plain/extensions/pi', consumerRoot)).toBe(path.join(root, 'dist/pi.mjs'));
  });

  it('prefers the import condition over the require build', () => {
    const root = install(
      '@scope/dual',
      {
        exports: { './extensions/pi': { types: './dist/pi.d.mts', require: './dist/pi.cjs', import: './dist/pi.mjs' } },
      },
      ['dist/pi.mjs', 'dist/pi.cjs'],
    );

    expect(consumerPackageEntry('@scope/dual/extensions/pi', consumerRoot)).toBe(path.join(root, 'dist/pi.mjs'));
  });

  it('falls through the condition order when import is absent', () => {
    const root = install('@scope/moduleonly', { exports: { '.': { module: './dist/index.mjs' } } }, ['dist/index.mjs']);

    expect(consumerPackageEntry('@scope/moduleonly', consumerRoot)).toBe(path.join(root, 'dist/index.mjs'));
  });

  it('takes the first usable entry of an array target', () => {
    const root = install('@scope/array', { exports: { '.': [{ import: './dist/a.mjs' }, './dist/b.mjs'] } }, [
      'dist/a.mjs',
    ]);

    expect(consumerPackageEntry('@scope/array', consumerRoot)).toBe(path.join(root, 'dist/a.mjs'));
  });

  it('resolves a bare package whose exports is a single string', () => {
    const root = install('bare', { exports: './index.mjs' }, ['index.mjs']);

    expect(consumerPackageEntry('bare', consumerRoot)).toBe(path.join(root, 'index.mjs'));
  });

  it('loads a file by path when the package does not export that subpath', () => {
    // Layers may point straight at a file inside a package even when that
    // package does not publish the file through its exports map.
    const root = install('unexported', { exports: { '.': './index.mjs' } }, ['index.mjs', 'extensions/pi.ts']);

    expect(consumerPackageEntry('unexported/extensions/pi.ts', consumerRoot)).toBe(path.join(root, 'extensions/pi.ts'));
  });

  it('loads a file by path when the package declares no exports at all', () => {
    const root = install('legacy', { name: 'legacy', main: 'index.js' }, ['extensions/pi.mjs']);

    expect(consumerPackageEntry('legacy/extensions/pi.mjs', consumerRoot)).toBe(path.join(root, 'extensions/pi.mjs'));
  });

  it('falls back to the direct path when the manifest cannot be parsed', () => {
    const root = install('broken', '{ not json', ['extensions/pi.mjs']);

    expect(consumerPackageEntry('broken/extensions/pi.mjs', consumerRoot)).toBe(path.join(root, 'extensions/pi.mjs'));
  });

  it('declines when an exported target does not exist on disk', () => {
    install('missing', { exports: { '.': './dist/index.mjs' } });

    expect(consumerPackageEntry('missing', consumerRoot)).toBeUndefined();
  });

  it('declines a root specifier that the package does not export', () => {
    install('subpathonly', { exports: { './extensions/pi': './dist/pi.mjs' } }, ['dist/pi.mjs']);

    expect(consumerPackageEntry('subpathonly', consumerRoot)).toBeUndefined();
  });

  it('declines a package the consumer has not installed', () => {
    expect(consumerPackageEntry('@scope/absent/extensions/pi', consumerRoot)).toBeUndefined();
  });

  it('skips array entries that resolve to nothing and keeps looking', () => {
    const root = install(
      '@scope/sparse',
      { exports: { '.': [{ require: './dist/a.cjs' }, { import: './dist/b.mjs' }] } },
      ['dist/b.mjs'],
    );

    expect(consumerPackageEntry('@scope/sparse', consumerRoot)).toBe(path.join(root, 'dist/b.mjs'));
  });

  it('declines an array with no import-side entry at all', () => {
    install('@scope/emptyarray', { exports: { '.': [] } });

    expect(consumerPackageEntry('@scope/emptyarray', consumerRoot)).toBeUndefined();
  });

  it('declines a condition map that offers no import-side target', () => {
    install('@scope/requireonly', { exports: { '.': { require: './dist/index.cjs' } } }, ['dist/index.cjs']);

    expect(consumerPackageEntry('@scope/requireonly', consumerRoot)).toBeUndefined();
  });

  it('declines a non-string, non-object export target', () => {
    install('@scope/weird', { exports: { '.': 42 } });

    expect(consumerPackageEntry('@scope/weird', consumerRoot)).toBeUndefined();
  });

  it('declines a null export target', () => {
    install('@scope/blocked', { exports: { '.': null } });

    expect(consumerPackageEntry('@scope/blocked', consumerRoot)).toBeUndefined();
  });

  it('collects extension files and nested index entries from a manifest directory', () => {
    const root = install('directory-manifest', { pi: { extensions: ['./extensions'] } }, [
      'extensions/first.ts',
      'extensions/ignored.txt',
      'extensions/nested/index.js',
      'extensions/without-index/readme.md',
    ]);

    expect(consumerPackageEntries('directory-manifest', consumerRoot)).toEqual([
      path.join(root, 'extensions/first.ts'),
      path.join(root, 'extensions/nested/index.js'),
    ]);
  });

  it('rejects malformed Pi extension declarations', () => {
    install('non-array-manifest', { pi: { extensions: './extension.ts' } }, ['extension.ts']);
    install('mixed-manifest', { pi: { extensions: ['./extension.ts', 7] } }, ['extension.ts']);

    expect(() => consumerPackageEntries('non-array-manifest', consumerRoot)).toThrow('must be an array of strings');
    expect(() => consumerPackageEntries('mixed-manifest', consumerRoot)).toThrow('must be an array of strings');
  });

  it('requires a nonempty resolvable Pi extension manifest', () => {
    install('manifest-fallback', { exports: './index.mjs' }, ['index.mjs']);
    install('empty-manifest', { pi: { extensions: [] } });
    install('missing-manifest-entry', { pi: { extensions: ['./missing.mjs'] } });

    expect(consumerPackageEntries('manifest-fallback', consumerRoot)).toEqual([]);
    expect(consumerPackageEntries('empty-manifest', consumerRoot)).toEqual([]);
    expect(consumerPackageEntries('missing-manifest-entry', consumerRoot)).toEqual([]);
  });

  it('applies manifest force-includes before final force-excludes', () => {
    const root = install(
      'manifest-overrides',
      {
        pi: {
          extensions: [
            './dist/first.mjs',
            './dist/first.mjs',
            './dist/second.mjs',
            '!**/*.mjs',
            '+dist/second.mjs',
            '-dist/second.mjs',
          ],
        },
      },
      ['dist/first.mjs', 'dist/second.mjs'],
    );

    expect(fs.existsSync(path.join(root, 'dist/second.mjs'))).toBe(true);
    expect(consumerPackageEntries('manifest-overrides', consumerRoot)).toEqual([]);
  });

  it('walks up to a parent node_modules directory', () => {
    const root = install('hoisted', { exports: { '.': './index.mjs' } }, ['index.mjs']);
    const nested = path.join(consumerRoot, 'apps', 'web');
    fs.mkdirSync(nested, { recursive: true });

    expect(consumerPackageEntry('hoisted', nested)).toBe(path.join(root, 'index.mjs'));
  });

  it('resolves a package provisioned in Pi project-local npm storage', () => {
    const root = installManaged('@scope/managed', { pi: { extensions: ['./dist/extensions/pi.mjs'] } }, [
      'dist/extensions/pi.mjs',
    ]);

    expect(consumerPackageEntries('@scope/managed', consumerRoot)).toEqual([path.join(root, 'dist/extensions/pi.mjs')]);
  });

  it('prefers the consumer dependency tree over Pi managed storage', () => {
    const installed = install('@scope/precedence', { exports: './consumer.mjs' }, ['consumer.mjs']);
    installManaged('@scope/precedence', { exports: './managed.mjs' }, ['managed.mjs']);

    expect(consumerPackageEntry('@scope/precedence', consumerRoot)).toBe(path.join(installed, 'consumer.mjs'));
  });

  it('reads a local package directory identity from its own manifest', () => {
    const root = install('@scope/local', { name: '@scope/local', exports: './index.mjs' }, ['index.mjs']);

    expect(localPackageName('.', root)).toBe('@scope/local');
  });

  it('does not borrow a parent manifest identity for a direct extension file', () => {
    const extension = path.join(consumerRoot, 'extension.ts');
    fs.writeFileSync(extension, 'export default () => undefined;');

    expect(localPackageName('./extension.ts', consumerRoot)).toBeUndefined();
  });
});
