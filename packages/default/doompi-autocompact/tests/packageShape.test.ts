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
    expect(packageJson.files).toEqual(expect.arrayContaining(['dist']));
    expect(packageJson.files?.some((entry) => /^(src|tests|coverage|\.env)/u.test(entry))).toBe(false);
  });

  it('uses local package tooling instead of rig-backed configuration', () => {
    const dependencyNames = Object.keys(packageJson.devDependencies ?? {});
    expect(dependencyNames.filter((name) => name.startsWith('@agimonai/rig-'))).toEqual([]);
    for (const config of ['tsconfig.json', 'tsdown.config.ts', 'vitest.config.ts', 'vibe-lint.config.yaml']) {
      expect(readConfig(config), config).not.toContain('@agimonai/rig-');
    }
  });

  it('declares ESM, CJS, declarations, and the private worker build entry', () => {
    const config = readConfig('tsdown.config.ts');
    expect(config).toMatch(/format\s*:\s*\[[^\]]*['"]esm['"][^\]]*['"]cjs['"]/u);
    expect(config).toMatch(/dts\s*:\s*\{[^}]*eager/u);
    expect(config).toContain("'*': 'src/exports/**/*.ts'");
    expect(config).toContain('src/adapters/process/checkpointWorker.ts');
  });

  it('keeps the standalone worker independent from package-local Pi resolution', () => {
    const worker = readConfig('src/adapters/process/checkpointWorker.ts');

    expect(worker).toContain('await import(input.piModuleUrl)');
    expect(worker).not.toMatch(/import\s+\{[^}]*generateSummary[^}]*\}\s+from/u);
  });
  it('resolves the private worker by walking from the emitted adapter', () => {
    const adapter = readConfig('src/adapters/pi/extension.ts');

    expect(adapter).toContain('findCheckpointWorkerUrl(import.meta.url)');
    expect(adapter).not.toMatch(/new URL\(['"]\.\.\//u);
  });

  it('keeps public exports closed while retaining the worker as a private artifact', () => {
    const exportsMap = packageJson.exports ?? {};
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (typeof target === 'string') {
        expect(target === './package.json' || target.startsWith('./dist/'), subpath).toBe(true);
        continue;
      }
      // Conditions are ordered types, import, require so a CJS consumer resolves
      // declarations before the runtime entry.
      expect(Object.keys(target as Record<string, string>), subpath).toEqual(['types', 'import', 'require']);
    }
    expect(exportsMap['.']).toMatchObject({ import: './dist/index.mjs', require: './dist/index.cjs' });
    expect(exportsMap['./extensions/pi']).toMatchObject({ import: './dist/extensions/pi.mjs' });
    expect(Object.keys(exportsMap).some((subpath) => subpath.includes('checkpointWorker'))).toBe(false);
  });
});
