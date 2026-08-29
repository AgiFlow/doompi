import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  exports?: Record<string, unknown>;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ProjectManifest {
  sourceRoot?: string;
  sourceTemplate?: string;
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(packageDirectory, 'package.json');

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

async function expectFile(relativePath: string): Promise<void> {
  await expect(access(path.resolve(packageDirectory, relativePath))).resolves.toBeUndefined();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return entry.name.endsWith('.ts') ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

describe('doom Pi UI package boundary', () => {
  it('retains the publishable package identity and exact Pi peer versions', async () => {
    const manifest = await readJsonFile<PackageManifest>(manifestPath);

    expect(manifest.name).toBe('@agimon-ai/doompi-ui');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.4');
    expect(manifest.devDependencies?.['@earendil-works/pi-tui']).toBe('0.84.4');
    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.4');
    expect(manifest.peerDependencies?.['@earendil-works/pi-tui']).toBe('0.84.4');
  });

  it('uses package-local project configuration without private rig packages or Doom Config runtime coupling', async () => {
    const project = await readJsonFile<ProjectManifest>(path.join(packageDirectory, 'project.json'));
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    expect(project.sourceRoot).toBe('packages/core/doompi-ui/src');
    expect(project.sourceTemplate).toBe('doom-extension');
    expect(manifest.dependencies?.['@agimon-ai/doompi-config']).toBeUndefined();

    const configurationFiles = [
      'package.json',
      'project.json',
      'tsconfig.json',
      'tsdown.config.ts',
      'vitest.config.ts',
      'vibe-lint.config.yaml',
      '.oxlintrc.json',
    ];
    for (const file of configurationFiles) {
      const contents = await readFile(path.join(packageDirectory, file), 'utf8').catch(() => '');
      expect(contents, file).not.toMatch(/@agimon-ai\/rig-/u);
    }

    for (const file of await sourceFiles(path.join(packageDirectory, 'src'))) {
      expect(await readFile(file, 'utf8'), file).not.toMatch(/@agimon-ai\/doompi-config/u);
    }
  });

  it('declares ESM, CJS, and declaration targets for every public entry', async () => {
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    const exportsMap = manifest.exports ?? {};
    // Module entries only. Static resources such as the packaged theme are
    // read as files by Pi, so they carry no import/require/types conditions.
    const publicEntries = Object.entries(exportsMap).filter(
      ([subpath]) => subpath !== './package.json' && !subpath.endsWith('.json'),
    );

    expect(publicEntries.length).toBeGreaterThan(0);
    expect(Object.keys(exportsMap)).not.toContain('./*');

    for (const [subpath, target] of publicEntries) {
      expect(conditionPaths(target, 'import'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'require'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'types'), subpath).toHaveLength(1);

      for (const output of targetPaths(target)) await expectFile(output);
    }
  });

  it('keeps exports closed and resolves every allowlisted package resource', async () => {
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    const exportsMap = manifest.exports ?? {};
    const files = manifest.files ?? [];

    expect(exportsMap['./package.json']).toBeDefined();
    for (const target of targetPaths(exportsMap['./package.json'])) await expectFile(target);
    expect(files.some((entry) => entry === 'dist' || entry === 'dist/**' || entry.startsWith('dist/'))).toBe(true);
    expect(files).not.toContain('src');
    expect(files).not.toContain('tests');

    for (const resource of files) {
      if (resource.includes('*')) continue;
      await expectFile(resource);
    }
  });
});
