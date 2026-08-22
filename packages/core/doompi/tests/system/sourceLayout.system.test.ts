import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectTsdownEntrySources, verifySourceLayout } from './sourceLayout.ts';

const temporaryRoots: string[] = [];

function createPackage(manifest: Record<string, unknown>, sources: readonly string[]): string {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-source-layout-'));
  temporaryRoots.push(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
  for (const source of sources) {
    const sourcePath = path.join(packageRoot, source);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'export const fixture = true;\n');
  }
  return packageRoot;
}

function reportFor(
  manifest: Record<string, unknown>,
  sources: readonly string[],
  configText: string,
  privateEntrySources: readonly string[] = [],
) {
  const packageRoot = createPackage(manifest, sources);
  return verifySourceLayout({
    packageRoot,
    manifest,
    tsdownEntrySources: collectTsdownEntrySources(configText),
    privateEntrySources,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('strict source layout verifier', () => {
  it('maps public export, bin, and Pi targets to src/exports and permits allowlisted private entries', () => {
    const manifest = {
      name: '@agimon-ai/example',
      exports: {
        '.': { types: './dist/index.d.mts', import: './dist/index.mjs', require: './dist/index.cjs' },
        './extensions/pi': {
          types: './dist/extensions/pi.d.mts',
          import: './dist/extensions/pi.mjs',
          require: './dist/extensions/pi.cjs',
        },
        './package.json': './package.json',
      },
      bin: { example: './dist/bin/example.mjs' },
      pi: { extensions: ['./dist/extensions/pi.mjs'] },
    };
    const report = reportFor(
      manifest,
      ['src/exports/index.ts', 'src/exports/extensions/pi.ts', 'src/exports/bin/example.ts', 'src/workers/worker.ts'],
      `entry: { '*': 'src/exports/**/*.ts', worker: 'src/workers/worker.ts' }`,
      ['src/workers/worker.ts'],
    );

    expect(report.issues).toEqual([]);
  });

  it('requires every non-public TSDown entry to be explicitly allowlisted', () => {
    const report = reportFor(
      { name: '@agimon-ai/example', exports: { '.': './dist/index.mjs' } },
      ['src/exports/index.ts', 'src/workers/worker.ts'],
      `entry: { '*': 'src/exports/**/*.ts', worker: 'src/workers/worker.ts' }`,
    );

    expect(report.issues).toContain('non-public tsdown entry is not allowlisted: src/workers/worker.ts');
  });

  it('requires allowlisted private sources to be actual TSDown entries', () => {
    const report = reportFor(
      { name: '@agimon-ai/example', exports: { '.': './dist/index.mjs' } },
      ['src/exports/index.ts', 'src/workers/worker.ts'],
      `entry: { '*': 'src/exports/**/*.ts' }`,
      ['src/workers/worker.ts'],
    );

    expect(report.issues).toContain('allowlisted private entry is missing from tsdown entries: src/workers/worker.ts');
  });

  it('does not exempt a malformed package manifest without a name', () => {
    const report = reportFor(
      { exports: { '.': './dist/index.mjs' } },
      ['src/exports/index.ts'],
      `entry: { '*': 'src/exports/**/*.ts' }`,
    );

    expect(report.issues).toContain('package manifest name is required');
  });

  it.each(['@agimon-ai/doompi-runner-rmux-linux-x64', '@agimon-ai/doompi-runner-rtk-linux-x64'])(
    'exempts source-less runner artifact package %s',
    (name) => {
      const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-artifact-layout-'));
      temporaryRoots.push(packageRoot);
      const report = verifySourceLayout({
        packageRoot,
        manifest: { name, exports: { './package.json': './package.json' } },
        tsdownEntrySources: [],
      });

      expect(report.issues).toEqual([]);
    },
  );

  it('rejects duplicate runtime targets across public export subpaths', () => {
    const report = reportFor(
      {
        name: '@agimon-ai/example',
        exports: {
          './one': './dist/shared.mjs',
          './two': './dist/shared.mjs',
        },
      },
      ['src/exports/shared.ts'],
      `entry: { shared: 'src/exports/shared.ts' }`,
    );

    expect(report.issues).toContain('runtime target is shared by multiple exports: ./dist/shared.mjs');
  });

  it('rejects orphan source facades under src/exports', () => {
    const report = reportFor(
      { name: '@agimon-ai/example', exports: { '.': './dist/index.mjs' } },
      ['src/exports/index.ts', 'src/exports/orphan.ts'],
      `entry: { '*': 'src/exports/**/*.ts' }`,
    );

    expect(report.issues).toContain('orphan source under src/exports: src/exports/orphan.ts');
  });
});
