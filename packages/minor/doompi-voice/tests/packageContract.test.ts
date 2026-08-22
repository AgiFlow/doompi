import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
  publishConfig?: { access?: string };
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ProjectConfiguration {
  sourceRoot?: string;
  sourceTemplate?: string;
  targets?: Record<string, { options?: Record<string, unknown> }>;
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(packageDirectory, 'package.json');
const piPackage = '@earendil-works/pi-coding-agent';
const expectedConfigurationFiles = [
  'package.json',
  'project.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'vitest.config.ts',
  'vibe-lint.config.yaml',
  '.oxlintrc.json',
];

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
}

async function readProject(): Promise<ProjectConfiguration> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'project.json'), 'utf8')) as ProjectConfiguration;
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

describe('doom voice package boundary', () => {
  it('retains the publishable package identity and exact Pi peer versions', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-voice');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig?.access).toBe('public');
    expect(manifest.peerDependencies?.[piPackage]).toBe('0.84.2');
    expect(manifest.devDependencies?.[piPackage]).toBe('0.84.2');
    expect(manifest.dependencies?.['sherpa-onnx-node']).toBe('1.13.6');
  });

  it('does not depend on private rig packages from package-local configuration', async () => {
    for (const file of expectedConfigurationFiles) {
      const contents = await readFile(path.join(packageDirectory, file), 'utf8').catch(() => '');
      expect(contents, file).not.toMatch(/@agimon-ai\/rig-/u);
    }
  });

  it('uses the package root as its source root with the Doom extension template', async () => {
    const project = await readProject();

    expect(project.sourceRoot).toBe('packages/minor/doompi-voice/src');
    expect(project.sourceTemplate).toBe('doom-extension');
  });

  it('avoids install-time preparation and prepares packages through build without changing the version', async () => {
    const manifest = await readManifest();
    const project = await readProject();
    const prepareTarget = project.targets?.['prepare-package'];

    expect(manifest.scripts?.prepare).toBeUndefined();
    expect(prepareTarget?.options?.buildTarget).toBe('build');
    expect(prepareTarget?.options?.updateVersionFile).toBe(false);
  });

  it('declares ESM, CJS, and declaration targets for every public entry', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};
    const publicEntries = Object.entries(exportsMap).filter(([subpath]) => subpath !== './package.json');

    expect(publicEntries.length).toBeGreaterThan(0);
    expect(exportsMap['./voice-tools']).toBeUndefined();
    expect(Object.keys(exportsMap)).not.toContain('./*');

    for (const [subpath, target] of publicEntries) {
      expect(conditionPaths(target, 'import'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'require'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'types'), subpath).toHaveLength(1);

      for (const output of targetPaths(target)) await expectFile(output);
    }
  });

  it('builds the voice worker as a private artifact', async () => {
    const manifest = await readManifest();
    const buildConfig = await readFile(path.join(packageDirectory, 'tsdown.config.ts'), 'utf8');
    const client = await readFile(path.join(packageDirectory, 'src/adapters/process/voiceWorkerClient.ts'), 'utf8');

    expect(buildConfig).toContain('src/adapters/process/voiceWorker.ts');
    expect(client).toContain('findVoiceWorkerUrl(import.meta.url)');
    expect(client).not.toMatch(/new URL\(['"]\.\.\//u);
    expect(Object.keys(manifest.exports ?? {}).some((subpath) => subpath.includes('voiceWorker'))).toBe(false);
  });

  it('keeps exports closed and resolves every allowlisted package resource', async () => {
    const manifest = await readManifest();
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

  it('ships the pinned Silero model and upstream license as package resources', async () => {
    const manifest = await readManifest();

    expect(manifest.files).toContain('models');
    await expectFile('models/silero_vad_v6.2.1.onnx');
    await expectFile('models/SILERO-LICENSE');
    await expectFile('models/README.md');
  });
});
