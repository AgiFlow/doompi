import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleExtensions, createLayerResolvers } from '../../src/services/extensionAssembler.ts';

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGE_MANIFEST = fileURLToPath(new URL('../../package.json', import.meta.url));
const temporaryRoots: string[] = [];

const FIXED_CORE_DEPENDENCIES = [
  '@agimon-ai/doompi-autostop',
  '@agimon-ai/doompi-cache',
  '@agimon-ai/doompi-config',
  '@agimon-ai/doompi-domain',
  '@agimon-ai/doompi-extension-contracts',
  '@agimon-ai/doompi-major-mode',
  '@agimon-ai/doompi-notification',
  '@agimon-ai/doompi-profile',
  '@agimon-ai/doompi-skill',
  '@agimon-ai/doompi-telemetry',
  '@agimon-ai/doompi-ui',
] as const;

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readManifest(): PackageManifest {
  return JSON.parse(fs.readFileSync(PACKAGE_MANIFEST, 'utf8')) as PackageManifest;
}

function selectablePackageNames(): string[] {
  const manifests = fs.globSync('{packages/default/*,packages/minor/*,layers/*/*}/package.json', {
    cwd: WORKSPACE_ROOT,
  });
  return manifests
    .map((manifest) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, manifest), 'utf8')) as { name?: unknown };
      if (typeof parsed.name !== 'string') throw new Error(`Package manifest has no name: ${manifest}`);
      return parsed.name;
    })
    .sort();
}

function makeRepository(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-consumer-composition-')));
  temporaryRoots.push(root);
  return root;
}

function installPiPackage(root: string, name: string, managed = false): string {
  const packageRoot = path.join(root, ...(managed ? ['.pi', 'npm'] : []), 'node_modules', name);
  const entry = path.join(packageRoot, 'dist', 'extensions', 'pi.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'export default function extension() {}\n');
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name, type: 'module', pi: { extensions: ['./dist/extensions/pi.mjs'] } }),
  );
  return entry;
}

function configuredPackages(root: string): MajorModesConfig {
  return {
    default: { baseDirectory: root, packages: ['@scope/baseline'] },
    layers: {
      team: {
        baseDirectory: root,
        packages: ['@scope/team', { name: '@scope/optional-companion', optional: true }],
      },
    },
    defaultMajorMode: 'baseline',
    majorMode: {
      baseline: { description: 'Only configured defaults.', layers: [] },
      combined: { description: 'Defaults plus the selected layer.', layers: ['team'] },
    },
  };
}

function assemble(root: string, config: MajorModesConfig, majorMode: string): string[] {
  return assembleExtensions({
    agents: true,
    autoStop: false,
    majorMode,
    majorModesConfig: config,
    layers: resolveLayers(config, majorMode),
    resolvers: createLayerResolvers(root),
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('DoomPi selectable package boundary', () => {
  it('keeps every default, minor, and layer package out of the root runtime closure', () => {
    const manifest = readManifest();
    const runtimeDependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };

    for (const name of selectablePackageNames()) expect(runtimeDependencies).not.toHaveProperty(name);
  });

  it('retains the fixed host foundation as workspace dependencies', () => {
    const { dependencies = {} } = readManifest();

    for (const name of FIXED_CORE_DEPENDENCIES) expect(dependencies[name]).toBe('workspace:*');
  });

  it('composes only the packages configured by the consumer', () => {
    const root = makeRepository();
    const baselineEntry = installPiPackage(root, '@scope/baseline');
    const teamEntry = installPiPackage(root, '@scope/team', true);
    const config = configuredPackages(root);

    const baseline = assemble(root, config, 'baseline');
    const combined = assemble(root, config, 'combined');

    expect(baseline).toContain(baselineEntry);
    expect(baseline).not.toContain(teamEntry);
    expect(combined).toContain(baselineEntry);
    expect(combined).toContain(teamEntry);
    expect(combined.indexOf(baselineEntry)).toBeLessThan(combined.indexOf(teamEntry));
  });

  it('does not resolve an absent selectable package through DoomPi private dependencies', () => {
    const root = makeRepository();
    const resolvers = createLayerResolvers(root);

    expect(resolvers.optionalPackageEntries?.('@agimon-ai/doompi-plan')).toBeUndefined();
    expect(() => resolvers.packageEntries?.('@agimon-ai/doompi-plan')).toThrow(
      'Cannot resolve configured package "@agimon-ai/doompi-plan"',
    );
  });

  it('allows fixed host entries to resolve from the DoomPi package closure', () => {
    const root = makeRepository();
    const entry = createLayerResolvers(root).packageEntry('@agimon-ai/doompi-config/extensions/pi');

    expect(fs.existsSync(entry)).toBe(true);
  });
});
