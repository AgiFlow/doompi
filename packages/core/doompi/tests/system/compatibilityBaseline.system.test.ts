import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_MATRIX, packageRootFor, RMUX_TARGETS, RTK_TARGETS } from './packageMatrix.ts';

interface PackageBaseline {
  exports: Record<string, string>;
  exportTargets: unknown;
  main: string | null;
  types: string | null;
  jsnextMain: string | null;
  bin: Record<string, string>;
  pi: { extensions?: string[] };
  assets: string[];
  files: string[];
  os: string[];
  cpu: string[];
}

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));
const CONTRACTS_SOURCE = fileURLToPath(new URL('../../../doompi-extension-contracts/src', import.meta.url));
const conditionCodes: Readonly<Record<string, string>> = { types: 't', import: 'i', require: 'r', default: 'd' };
const packageBaseline = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_ROOT, 'packageCompatibility.json'), 'utf8'),
) as Record<string, PackageBaseline>;
const protocolBaseline = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_ROOT, 'protocolChannels.json'), 'utf8'),
) as string[];

function readManifest(packageName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(packageRootFor(packageName), 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function exportConditions(exportsValue: unknown): Record<string, string> {
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return {};
  return Object.fromEntries(
    Object.entries(exportsValue).map(([subpath, target]) => [
      subpath,
      typeof target === 'string'
        ? 'esm'
        : Object.keys(target as Record<string, unknown>)
            .map((condition) => conditionCodes[condition] ?? condition)
            .join(''),
    ]),
  );
}

function collectProtocolChannels(): string[] {
  const channels = new Set<string>();
  const literal = /['"](doom:[^'"]+)['"]/gu;
  const pending = [CONTRACTS_SOURCE];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const source = fs.readFileSync(entryPath, 'utf8');
      for (const match of source.matchAll(literal)) channels.add(match[1]!);
    }
  }
  return [...channels].sort();
}

describe('frozen published package compatibility baseline', () => {
  it('covers the complete owned package matrix without inferred additions', () => {
    expect(Object.keys(packageBaseline).sort()).toEqual(PACKAGE_MATRIX.map(({ name }) => name).sort());
  });

  it.each(PACKAGE_MATRIX)(
    '$name preserves exports, conditions, bins, Pi entries, resources, and platform metadata',
    ({ name }) => {
      const manifest = readManifest(name);
      const baseline = packageBaseline[name];
      if (!baseline) throw new Error(`Missing compatibility baseline for ${name}`);

      expect(exportConditions(manifest.exports)).toEqual(baseline.exports);
      expect(manifest.exports).toEqual(baseline.exportTargets);
      expect(manifest.main ?? null).toBe(baseline.main);
      expect(manifest.types ?? null).toBe(baseline.types);
      expect(manifest['jsnext:main'] ?? null).toBe(baseline.jsnextMain);
      expect(manifest.bin ?? {}).toEqual(baseline.bin);
      expect(manifest.pi ?? {}).toEqual(baseline.pi);
      for (const asset of baseline.assets) {
        expect(
          fs.existsSync(path.join(packageRootFor(name), asset.replace(/^\.\//u, ''))),
          `${name} is missing ${asset}`,
        ).toBe(true);
      }
      expect(manifest.files ?? []).toEqual(baseline.files);
      expect(manifest.os ?? []).toEqual(baseline.os);
      expect(manifest.cpu ?? []).toEqual(baseline.cpu);
    },
  );

  it('freezes all four artifact-only RMUX target tuples', () => {
    expect(
      RMUX_TARGETS.map(({ platform, architecture, packageName }) => ({ platform, architecture, packageName })),
    ).toEqual([
      { platform: 'darwin', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rmux-darwin-arm64' },
      { platform: 'darwin', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rmux-darwin-x64' },
      { platform: 'linux', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rmux-linux-arm64' },
      { platform: 'linux', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rmux-linux-x64' },
    ]);
    for (const { packageName } of RMUX_TARGETS) {
      expect(fs.existsSync(path.join(packageRootFor(packageName), 'src'))).toBe(false);
    }
  });

  it('freezes all four artifact-only RTK target tuples', () => {
    expect(
      RTK_TARGETS.map(({ platform, architecture, packageName }) => ({ platform, architecture, packageName })),
    ).toEqual([
      { platform: 'darwin', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rtk-darwin-arm64' },
      { platform: 'darwin', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rtk-darwin-x64' },
      { platform: 'linux', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rtk-linux-arm64' },
      { platform: 'linux', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rtk-linux-x64' },
    ]);
    for (const { packageName } of RTK_TARGETS) {
      expect(fs.existsSync(path.join(packageRootFor(packageName), 'src'))).toBe(false);
    }
  });

  it('freezes the sole legacy EventBus channel used to discover the Cordis host', () => {
    expect(collectProtocolChannels()).toEqual(protocolBaseline);
  });
});
