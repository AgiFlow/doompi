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
  doompiServer?: { entry?: string; dist?: string; scopes?: string[] };
  pi?: { extensions?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;

function readConfig(name: string): string {
  return fs.readFileSync(path.join(packageRoot, name), 'utf8');
}

describe('@agimon-ai/doompi-plan package shape', () => {
  it('keeps the publishable package identity and publishes built output plus Help resources', () => {
    expect(packageJson).toMatchObject({
      name: '@agimon-ai/doompi-plan',
      version: expect.stringMatching(SEMVER_PATTERN),
      type: 'module',
    });
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.files).toEqual(expect.arrayContaining(['dist', 'llms.txt', 'src/prompts', 'README.md']));
    expect(packageJson.files?.some((entry) => /^(tests|coverage|\.env)/u.test(entry))).toBe(false);
  });

  it('depends on shared Cordis contracts rather than a concrete feedback provider', () => {
    expect(packageJson.dependencies?.['@agimon-ai/doompi-core']).toBe('workspace:*');
    expect(packageJson.dependencies?.['@agimon-ai/doompi-user-feedback']).toBeUndefined();
  });

  it('uses local package tooling instead of rig-backed configuration', () => {
    const dependencyNames = Object.keys(packageJson.devDependencies ?? {});
    expect(dependencyNames.filter((name) => name.startsWith('@agimonai/rig-'))).toEqual([]);
    for (const config of ['tsconfig.json', 'tsdown.config.ts', 'vitest.config.ts', 'vibe-lint.config.yaml']) {
      expect(readConfig(config), config).not.toContain('@agimonai/rig-');
    }
  });

  it('uses the routed extension preset for its host entries', () => {
    const config = readConfig('tsdown.config.ts');
    expect(config).toContain("import { doompiExtension } from '@agimon-ai/doompi-build/tsdown'");
    expect(config).toContain('doompiExtension({');
  });

  it('keeps the package export map closed and explicit', () => {
    const exportsMap = packageJson.exports ?? {};
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (typeof target === 'string') {
        expect(target === './package.json' || target.startsWith('./dist/'), subpath).toBe(true);
        continue;
      }
      if (subpath === './extensions/web') {
        expect(target).toEqual({ import: './dist/extensions/web.mjs' });
        continue;
      }
      expect(Object.keys(target as Record<string, string>), subpath).toEqual(['types', 'import', 'require']);
    }
    expect(exportsMap['.']).toMatchObject({ import: './dist/index.mjs' });
    expect(exportsMap['./extensions/pi']).toMatchObject({ import: './dist/extensions/pi.mjs' });
    expect(exportsMap['./extensions/server']).toEqual({
      types: './dist/extensions/server.d.mts',
      import: './dist/extensions/server.mjs',
      require: './dist/extensions/server.cjs',
    });
    expect(packageJson.doompiServer).toEqual({
      contracts: { entry: './src/exports/apiContracts.ts', dist: './dist/api-contracts.mjs' },
      entry: './generated/server.ts',
      dist: './dist/extensions/server.mjs',
      scopes: ['session'],
    });
    expect(packageJson.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });
});
