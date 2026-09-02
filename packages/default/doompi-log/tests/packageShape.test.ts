import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type JsonRecord = Record<string, unknown>;

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_MANIFEST = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as JsonRecord;
const PROJECT_CONFIG = readFileSync(resolve(PACKAGE_ROOT, 'project.json'), 'utf8');
const CONFIG_FILES = ['tsdown.config.ts', 'tsconfig.json', 'vitest.config.ts', 'vibe-lint.config.yaml'];
const EXPORT_SUBPATHS = [
  '.',
  './extensions/pi',
  // The hub-scoped metrics API the cockpit host imports; declared in doompiApi.
  './hub-api',
  './metrics',
  './metricsSource',
  './tui/metricsOverlay',
  './package.json',
];
const PI_ENTRY = './dist/extensions/pi.mjs';

function objectValue(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as JsonRecord;
}

function dependencyNames(value: unknown): string[] {
  return Object.keys(objectValue(value));
}

describe('@agimon-ai/doompi-log package shape', () => {
  it('keeps the publishable package identity', () => {
    expect(PACKAGE_MANIFEST.name).toBe('@agimon-ai/doompi-log');
    expect(PACKAGE_MANIFEST.private).toBeUndefined();
    expect(PACKAGE_MANIFEST.version).toMatch(SEMVER_PATTERN);
  });

  it('does not retain rig packages or the doom-pi-ui hard dependency', () => {
    expect(dependencyNames(PACKAGE_MANIFEST.dependencies)).not.toContain('@agimon-ai/doompi-ui');
    expect(dependencyNames(PACKAGE_MANIFEST.dependencies)).not.toContainEqual(
      expect.stringMatching(/^@agimon-ai\/rig-/),
    );
    expect(dependencyNames(PACKAGE_MANIFEST.devDependencies)).not.toContainEqual(
      expect.stringMatching(/^@agimon-ai\/rig-/),
    );
  });

  it('uses package-local configuration and records its source template', () => {
    expect(PROJECT_CONFIG).toContain('"sourceRoot": "packages/default/doompi-log/src"');
    expect(PROJECT_CONFIG).toContain('"sourceTemplate": "doom-extension"');
    for (const file of CONFIG_FILES) {
      expect(readFileSync(resolve(PACKAGE_ROOT, file), 'utf8')).not.toMatch(/@agimon-ai\/rig-/);
    }
  });

  it('declares only allowlisted built exports and a discoverable Pi entry', () => {
    const exports = objectValue(PACKAGE_MANIFEST.exports);
    expect(Object.keys(exports).sort()).toEqual([...EXPORT_SUBPATHS].sort());
    expect(exports).not.toHaveProperty('./*');
    expect(readFileSync(resolve(PACKAGE_ROOT, 'src/exports/index.ts'), 'utf8')).not.toMatch(
      /create(?:DoomLog|PiTelemetry)Extension/u,
    );

    const serializedExports = JSON.stringify(exports);
    expect(serializedExports).toContain('.mjs');
    expect(serializedExports).toContain('.cjs');
    expect(serializedExports).toMatch(/\.d\.[cm]?ts/);

    const pi = objectValue(PACKAGE_MANIFEST.pi);
    expect(pi.extensions).toEqual([PI_ENTRY]);
  });
});
