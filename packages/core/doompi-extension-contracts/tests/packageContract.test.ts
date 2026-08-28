import { access, readFile } from 'node:fs/promises';
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
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(packageDirectory, 'package.json');

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
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
  const absolutePath = path.resolve(packageDirectory, relativePath);
  await expect(access(absolutePath)).resolves.toBeUndefined();
}

describe('doom extension contracts package boundary', () => {
  it('retains the publishable package identity and ESM declaration', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-extension-contracts');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
  });

  it('does not depend on private rig packages from package-local configuration', async () => {
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
  });

  it('keeps child-process environment constants owned by the contracts source', async () => {
    const owner = await readFile(path.join(packageDirectory, 'src/schemas/childProcess.ts'), 'utf8');
    const constants = [
      'SUBAGENT_CHILD_ENV',
      'SUBAGENT_PARENT_SESSION_ENV',
      'SUBAGENT_ROOT_SESSION_ENV',
      'DOOM_CHILD_PROCESS_CONTEXT_ENV',
    ];

    for (const constant of constants) expect(owner).toMatch(new RegExp(`export const ${constant}\\b`, 'u'));

    const consumers = [
      path.resolve(packageDirectory, '../../../layers/team/doompi-team/src/exports/env.ts'),
      path.resolve(packageDirectory, '../../../layers/team/doompi-team/src/adapters/runs/shared/piArgs.ts'),
    ];
    for (const consumer of consumers) {
      const contents = await readFile(consumer, 'utf8');
      for (const constant of constants) expect(contents).not.toMatch(new RegExp(`const ${constant}\\s*=`, 'u'));
    }
  });

  it('declares ESM, CJS, and declaration targets for every public entry', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};
    const publicEntries = Object.entries(exportsMap).filter(([subpath]) => subpath !== './package.json');

    expect(publicEntries.length).toBeGreaterThan(0);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(exportsMap['./voice-tools']).toEqual({
      types: './dist/voiceTools.d.mts',
      import: './dist/voiceTools.mjs',
      require: './dist/voiceTools.cjs',
    });
    expect(exportsMap['./mcp-projection']).toEqual({
      types: './dist/mcpProjection.d.mts',
      import: './dist/mcpProjection.mjs',
      require: './dist/mcpProjection.cjs',
    });
    expect(exportsMap['./cordis-host']).toEqual({
      types: './dist/cordisHost.d.mts',
      import: './dist/cordisHost.mjs',
      require: './dist/cordisHost.cjs',
    });
    expect(exportsMap['./notification']).toEqual({
      types: './dist/notification.d.mts',
      import: './dist/notification.mjs',
      require: './dist/notification.cjs',
    });
    expect(exportsMap['./readiness']).toEqual({
      types: './dist/readiness.d.mts',
      import: './dist/readiness.mjs',
      require: './dist/readiness.cjs',
    });

    for (const [subpath, target] of publicEntries) {
      expect(conditionPaths(target, 'import'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'require'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'types'), subpath).toHaveLength(1);

      for (const output of targetPaths(target)) await expectFile(output);
    }
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
});
