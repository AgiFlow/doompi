import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  files?: string[];
  exports?: Record<string, unknown>;
  devDependencies?: Record<string, string>;
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;

function readConfig(name: string): string {
  return fs.readFileSync(path.join(packageRoot, name), 'utf8');
}

describe('@agimon-ai/doompi-autocompact package shape', () => {
  it('keeps the publishable package identity and publishes only the built package resources', () => {
    expect(packageJson).toMatchObject({
      name: '@agimon-ai/doompi-autocompact',
      version: expect.stringMatching(SEMVER_PATTERN),
      type: 'module',
    });
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.files).toEqual(['dist']);
    expect(packageJson.files?.filter((entry) => entry.startsWith('src/'))).toEqual([]);
    expect(packageJson.files?.some((entry) => /^(tests|coverage|\.env)/u.test(entry))).toBe(false);
  });

  it('uses local package tooling instead of rig-backed configuration', () => {
    const dependencyNames = Object.keys(packageJson.devDependencies ?? {});
    expect(dependencyNames.filter((name) => name.startsWith('@agimonai/rig-'))).toEqual([]);
    for (const config of ['tsconfig.json', 'tsdown.config.ts', 'vitest.config.ts', 'vibe-lint.config.yaml']) {
      expect(readConfig(config), config).not.toContain('@agimonai/rig-');
    }
  });

  it('declares ESM, CJS, and declaration build entries for the public exports only', () => {
    const config = readConfig('tsdown.config.ts');
    expect(config).toContain("import { doompiExtension } from '@agimon-ai/doompi-build/tsdown'");
    expect(config).toContain('defineConfig(doompiExtension())');
    expect(config).not.toContain('src/adapters/');
  });

  it('summarizes through the session provider instead of a separate thread', () => {
    const adapter = readConfig('src/services/autocompactRuntime/index.ts');

    expect(adapter).toContain('provider.streamSimple(model, context, options)');
    expect(adapter).not.toContain('node:worker_threads');
  });

  it('keeps public exports closed to the built entry points', () => {
    const exportsMap = packageJson.exports ?? {};
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (typeof target === 'string') {
        expect(target === './package.json' || target.startsWith('./dist/'), subpath).toBe(true);
        continue;
      }
      const conditions = Object.keys(target as Record<string, string>);
      expect(conditions, subpath).toEqual(subpath === './extensions/web' ? ['import'] : ['types', 'import', 'require']);
    }
    expect(exportsMap['.']).toMatchObject({ import: './dist/index.mjs', require: './dist/index.cjs' });
    expect(exportsMap['./extensions/pi']).toMatchObject({ import: './dist/extensions/pi.mjs' });
    expect(Object.keys(exportsMap).some((subpath) => subpath.includes('adapters'))).toBe(false);
  });
});
