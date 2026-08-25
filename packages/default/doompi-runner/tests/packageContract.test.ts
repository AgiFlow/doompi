import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  main?: string;
  types?: string;
  'jsnext:main'?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

interface ProjectManifest {
  sourceRoot?: string;
  sourceTemplate?: string;
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(packageDirectory, 'package.json');
const projectPath = path.join(packageDirectory, 'project.json');
const packageJsonConfigFiles = [
  'package.json',
  'project.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'vitest.config.ts',
  'vibe-lint.config.yaml',
  '.oxlintrc.json',
];

async function readJsonFile<TValue>(filePath: string): Promise<TValue> {
  return JSON.parse(await readFile(filePath, 'utf8')) as TValue;
}

function targetPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targetPaths);
}

function conditionPaths(value: unknown, condition: string): string[] {
  if (typeof value === 'string' || value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const direct = record[condition];
  return direct === undefined
    ? Object.values(record).flatMap((nested) => conditionPaths(nested, condition))
    : targetPaths(direct);
}

function includesPath(files: readonly string[], target: string): boolean {
  return files.some(
    (entry) => entry === target || entry === `${target}/` || entry === `${target}/**` || entry.startsWith(`${target}/`),
  );
}

async function expectFile(relativePath: string): Promise<void> {
  await expect(access(path.resolve(packageDirectory, relativePath))).resolves.toBeUndefined();
}

describe('doom runner package boundary', () => {
  it('retains the publishable package identity and package-local project configuration', async () => {
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    const project = await readJsonFile<ProjectManifest>(projectPath);

    expect(manifest.name).toBe('@agimon-ai/doompi-runner');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('./dist/index.cjs');
    expect(manifest.types).toBe('./dist/index.d.mts');
    expect(manifest['jsnext:main']).toBe('./dist/index.mjs');
    expect(project.sourceRoot).toBe('packages/default/doompi-runner/src');
    expect(project.sourceTemplate).toBe('doom-extension');
    expect(manifest.dependencies?.['@deepseek-ai/cordis']).toBe('4.0.1');
    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.3');
    expect(manifest.peerDependencies?.['@earendil-works/pi-tui']).toBe('0.84.3');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.3');
    expect(manifest.devDependencies?.['@earendil-works/pi-tui']).toBe('0.84.3');
    expect(manifest.dependencies?.['node-pty']).toBeUndefined();
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      expect(manifest.optionalDependencies?.[`@agimon-ai/doompi-runner-rtk-${target}`]).toBe('workspace:*');
    }
    for (const file of packageJsonConfigFiles) {
      const contents = await readFile(path.join(packageDirectory, file), 'utf8');
      expect(contents, file).not.toMatch(/@agimon-ai\/rig-/u);
    }
  });

  it('publishes every explicit entry as ESM, CJS, and declarations', async () => {
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    const exportsMap = manifest.exports ?? {};
    const publicEntries = Object.entries(exportsMap).filter(([subpath]) => subpath !== './package.json');

    expect(publicEntries.length).toBeGreaterThan(0);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(Object.keys(exportsMap)).not.toContain('./extension');
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);

    for (const [subpath, target] of publicEntries) {
      expect(conditionPaths(target, 'import'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'require'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'types'), subpath).toHaveLength(1);

      for (const output of targetPaths(target)) await expectFile(output);
    }
  });

  it('closes the export surface and allowlists built output plus packaged skills', async () => {
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    const exportsMap = manifest.exports ?? {};
    const files = manifest.files ?? [];

    expect(exportsMap['./package.json']).toBe('./package.json');
    await expectFile('package.json');
    expect(includesPath(files, 'dist')).toBe(true);
    expect(includesPath(files, 'skills')).toBe(true);
    expect(files).not.toContain('src');
    expect(files).not.toContain('tests');

    for (const resource of files) {
      if (resource.includes('*')) continue;
      await expectFile(resource);
    }
  });
});
