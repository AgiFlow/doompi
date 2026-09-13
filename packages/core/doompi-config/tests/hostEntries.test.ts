import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  globalDoomConfigPath,
  loadDoomConfig,
  loadDoomConfigAsync,
  repositoryDoomConfigPath,
} from '../src/exports/config';

const roots: string[] = [];
const PI_EXTENSION_PATH = '../src/extensions/pi.ts';
const PI_CONFIG_PATH = '../src/exports/piConfig.ts';
const PI_CONFIG_SERVICE_PATH = '../src/services/piConfig/index.ts';
const TYPES_PATH = '../src/types/piConfig.ts';
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MODULE_IMPORT_TIMEOUT_MS = 15_000;

async function importSourceModule(relativePath: string): Promise<Record<string, unknown>> {
  const absolutePath = path.resolve(TEST_DIRECTORY, relativePath);
  return (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('configuration host entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'exposes one Pi factory while keeping the Pi config loader host-neutral',
    async () => {
      const [piModule, piConfigSource, schemaSource] = await Promise.all([
        importSourceModule(PI_EXTENSION_PATH),
        fs.promises.readFile(path.resolve(TEST_DIRECTORY, PI_CONFIG_SERVICE_PATH), 'utf8'),
        fs.promises.readFile(path.resolve(TEST_DIRECTORY, TYPES_PATH), 'utf8'),
      ]);

      expect(piModule.default).toBeTypeOf('function');
      expect(fs.existsSync(path.resolve(TEST_DIRECTORY, '../src/exports/extensions'))).toBe(false);
      expect(piConfigSource).toContain('programmatic');
      expect(piConfigSource).toContain('environment');
      expect(piConfigSource).toContain('trusted');
      expect(schemaSource).toContain('projectTrust');
      expect(piConfigSource).not.toMatch(/\.doom|loadDoomConfig/u);
      expect(piConfigSource).not.toContain("from '@earendil-works/pi-coding-agent'");
    },
    MODULE_IMPORT_TIMEOUT_MS,
  );

  it('ignores malformed Doom YAML when using the standard Pi entry', async () => {
    const repo = temporaryRoot('doom-pi-adapter-');
    const home = temporaryRoot('doom-pi-home-');
    write(repositoryDoomConfigPath(repo), 'not: [valid\n');

    const piConfigModule = await importSourceModule(PI_CONFIG_PATH);
    const loadPiConfig = piConfigModule.loadPiConfig;
    expect(loadPiConfig).toBeTypeOf('function');

    const result = await (loadPiConfig as (options: Record<string, unknown>) => unknown)({
      repoRoot: repo,
      homeDirectory: home,
      programmatic: {},
      environment: {},
      cli: {},
      isProjectTrusted: true,
    });
    expect(result).toBeDefined();
  });

  it('keeps Doom YAML as an overlay before trusted Pi project settings', () => {
    const repo = temporaryRoot('doom-config-adapter-');
    const home = temporaryRoot('doom-config-home-');
    write(globalDoomConfigPath(home), 'projectTrust: always\neditor:\n  command: global\n');
    write(repositoryDoomConfigPath(repo), 'editor:\n  command: repository\n');

    expect(loadDoomConfig(repo, home)).toMatchObject({ projectTrust: 'ask', editor: { command: 'global' } });
  });

  it('loads Doom YAML asynchronously with the same precedence', async () => {
    const repo = temporaryRoot('doom-config-async-');
    const home = temporaryRoot('doom-config-async-home-');
    write(globalDoomConfigPath(home), 'projectTrust: always\neditor:\n  command: global\n');
    write(repositoryDoomConfigPath(repo), 'projectTrust: never\n');

    await expect(loadDoomConfigAsync(repo, home)).resolves.toMatchObject({
      projectTrust: 'never',
      editor: { command: 'global' },
    });
  });

  it('loads Pi settings asynchronously in override order', async () => {
    const repo = temporaryRoot('pi-config-async-');
    const home = temporaryRoot('pi-config-async-home-');
    const first = path.join(home, 'first.json');
    const second = path.join(home, 'second.json');
    write(first, JSON.stringify({ theme: 'first', nested: { first: true } }));
    write(second, JSON.stringify({ theme: 'second', nested: { second: true } }));
    const piConfigModule = await importSourceModule(PI_CONFIG_PATH);
    const loadPiConfigAsync = piConfigModule.loadPiConfigAsync as (
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    await expect(
      loadPiConfigAsync({ repoRoot: repo, homeDirectory: home, userConfigPaths: [first, second] }),
    ).resolves.toMatchObject({ theme: 'second', nested: { first: true, second: true } });
  });

  it('joins the shared Cordis host instead of constructing a package-local root', async () => {
    const piModule = await importSourceModule(PI_EXTENSION_PATH);
    const piSource = await fs.promises.readFile(path.resolve(TEST_DIRECTORY, PI_EXTENSION_PATH), 'utf8');

    expect(piModule.default).toBeTypeOf('function');
    expect(piSource).toContain('definePiExtension(PACKAGE_SOURCE');
    expect(piSource).toContain('services: [runtime.plugin]');
    expect(piSource).toContain('events: { session_start: runtime.onSessionStart }');
    expect(piSource).not.toContain('new Context()');
    expect(piSource).not.toContain('registeredHosts');
  });
});
