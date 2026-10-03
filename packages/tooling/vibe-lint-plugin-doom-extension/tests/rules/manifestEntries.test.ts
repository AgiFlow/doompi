import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as build from '@agimon-ai/doompi-build';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type GeneratedEntryCache,
  generatedEntrySource,
  hostEntryStems,
  piDiscoveryEntryStems,
  projectPath,
  readPackageManifest,
  runtimeStem,
  runtimeTargets,
  sourceStem,
} from '../../src/rules/manifestEntries.js';

describe('Doom manifest entry helpers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-manifest-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(value: unknown): void {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(value), 'utf8');
  }

  it('shares scans and rendered sources per root only within an explicit check cache, without disk output', () => {
    writeManifest({ name: '@agimon-ai/doompi-demo' });
    const sourceDir = path.join(root, 'src/extensions/(backend)/tool');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'hello.cli.ts'), 'export default {};');
    const scan = vi.spyOn(build, 'scanExtensions');
    const render = vi.spyOn(build, 'renderCliEntry');
    const cache: GeneratedEntryCache = new Map();
    const source = generatedEntrySource(root, 'generated/pi.ts', cache);
    expect(source).toContain('definePiExtension');
    expect(generatedEntrySource(path.join(root, '.'), 'generated/pi.ts', cache)).toBe(source);
    expect(generatedEntrySource(root, 'generated/server.ts', cache)).toBeNull();
    expect(generatedEntrySource(root, 'generated/server.ts', cache)).toBeNull();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(generatedEntrySource(sourceDir, 'generated/pi.ts', cache)).toBeNull();
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    expect(generatedEntrySource(root, 'generated/pi.ts', new Map())).toBeNull();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(root)).toEqual(['package.json']);
  });

  it('normalizes project-relative paths and rejects paths outside the project', () => {
    expect(projectPath(path.join(root, 'src', 'extensions', 'pi.ts'), root)).toBe('src/extensions/pi.ts');
    expect(projectPath(root, root)).toBe('');
    expect(projectPath(path.join(path.dirname(root), 'outside.ts'), root)).toBeNull();
  });

  it('reads valid package manifests and treats missing or malformed files as absent', () => {
    expect(readPackageManifest(root)).toBeNull();
    writeManifest({ name: '@agimon-ai/example' });
    expect(readPackageManifest(root)).toEqual({ name: '@agimon-ai/example' });
    fs.writeFileSync(path.join(root, 'package.json'), '{invalid', 'utf8');
    expect(readPackageManifest(root)).toBeNull();
  });

  it('collects runtime targets through nested export conditions', () => {
    expect(runtimeTargets('./dist/index.mjs')).toEqual(['./dist/index.mjs']);
    expect(runtimeTargets('./src/index.ts')).toEqual([]);
    expect(
      runtimeTargets({
        import: './dist/index.mjs',
        node: { require: './dist/index.cjs' },
        types: './dist/index.d.mts',
        extras: ['./dist/worker.js', null],
      }),
    ).toEqual(['./dist/index.mjs', './dist/index.cjs', './dist/worker.js']);
    expect(runtimeTargets(null)).toEqual([]);
    expect(runtimeTargets(42)).toEqual([]);
  });

  it('maps runtime and source paths to matching entry stems', () => {
    expect(runtimeStem('./dist/extensions/pi.mjs')).toBe('extensions/pi');
    expect(runtimeStem('dist\\entries\\worker.cjs')).toBe('entries/worker');
    expect(runtimeStem('./src/extensions/pi.ts')).toBeNull();
    expect(runtimeStem('./dist/readme.txt')).toBeNull();

    expect(sourceStem('src/exports/extensions/pi.ts')).toBe('extensions/pi');
    expect(sourceStem('src/extensions/pi.mts')).toBe('extensions/pi');
    expect(sourceStem('tests/extensions/pi.ts')).toBeNull();
    expect(sourceStem('src/extensions/pi.js')).toBeNull();
  });

  it('derives Pi discovery entries from the manifest', () => {
    expect(piDiscoveryEntryStems(root)).toEqual(new Set());
    writeManifest({
      pi: {
        extensions: ['./dist/extensions/pi.mjs', { import: './dist/entries/voice.js', types: './dist/voice.d.mts' }],
      },
    });

    expect(piDiscoveryEntryStems(root)).toEqual(new Set(['extensions/pi', 'entries/voice']));
  });

  it('combines Pi discovery and public extension exports for host entries', () => {
    writeManifest({
      pi: { extensions: './dist/extensions/pi.mjs' },
      exports: {
        '.': './dist/index.mjs',
        './pi': { import: './dist/entries/legacy.mjs' },
        './extensions/voice': ['./dist/extensions/voice.mjs', './dist/extensions/voice.cjs'],
        './services/run': './dist/services/run.mjs',
      },
    });

    expect(hostEntryStems(root)).toEqual(new Set(['extensions/pi', 'entries/legacy', 'extensions/voice']));
  });

  it('handles manifests without object export maps', () => {
    writeManifest({ exports: ['./dist/index.mjs'] });
    expect(hostEntryStems(root)).toEqual(new Set());
  });
});
