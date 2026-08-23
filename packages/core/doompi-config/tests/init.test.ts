import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  DOOM_CONFIG_TEMPLATES,
  GLOBAL_DOOM_SEED_FILES,
  globalDoomConfigDirectory,
  initializeGlobalDoomConfig,
  initializeRepositoryDoomConfig,
  parseDoomConfig,
  REPOSITORY_DOOM_CONFIG_TEMPLATES,
} from '../src/exports/index.ts';

const temporaryRoots: string[] = [];
const MAJOR_MODES = ['minimal', 'copilot'] as const;
const DEFAULT_LAYER_PACKAGES = {
  team: '@agimon-ai/doompi-team',
  'ask-user': '@agimon-ai/doompi-user-feedback',
  task: '@agimon-ai/doompi-task',
} as const;
const DEFAULT_DISTRIBUTION_PACKAGES = [
  '@agimon-ai/doompi-help',
  '@agimon-ai/doompi-hook',
  '@agimon-ai/doompi-goal',
  '@agimon-ai/doompi-voice',
  '@agimon-ai/doompi-runner',
  '@agimon-ai/doompi-read',
  '@agimon-ai/doompi-grep',
  '@agimon-ai/doompi-edit',
  '@agimon-ai/doompi-file-edit',
  '@agimon-ai/doompi-autocompact',
  '@agimon-ai/doompi-loop',
  '@agimon-ai/doompi-plan',
  '@agimon-ai/doompi-workflow',
  '@agimon-ai/doompi-log',
  '@agimon-ai/doompi-mcp',
] as const;
const MINIMAL_DEFAULT_LAYERS = ['team', 'task'] as const;
const COPILOT_DEFAULT_LAYERS = ['team', 'ask-user', 'task'] as const;
/**
 * Scopes that only resolve inside a private repository. A seeded layer naming
 * one of these is a broken layer for every other consumer, and an unscoped name
 * can resolve to an unrelated package on the public registry.
 */
const PRIVATE_SCOPES = ['@agiflowai/', '@agimonai/'];

type LayerPackage = string | { name: string; optional?: boolean; config?: Record<string, unknown> };
interface MajorModesDocument {
  default: { packages: LayerPackage[] };
  layers: Record<string, { packages?: LayerPackage[] }>;
  majorMode: Record<string, { description: string; layers: string[] }>;
}

function packagesForMajorMode(source: string, majorMode: string): string[] {
  const document = parseYaml(source) as MajorModesDocument;
  return (document.majorMode[majorMode]?.layers ?? []).flatMap((layerName) =>
    (document.layers[layerName]?.packages ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.name)),
  );
}

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-global-init-'));
  temporaryRoots.push(home);
  return home;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('initializeGlobalDoomConfig', () => {
  it('seeds autonomous voice as a commented opt-in example', () => {
    const template = DOOM_CONFIG_TEMPLATES['config.yaml'];

    expect(template).toContain('#   autoCapture:');
    expect(template).toContain('#     model: provider/model-id');
    expect(template).toContain('#     utteranceIdleMs: 3000');
    expect(template).toContain('#       engine: macos-say');
    expect(parseDoomConfig(template, '/config.yaml')).toMatchObject({ projectTrust: 'ask', voice: undefined });
  });

  it('documents how to edit layers, package configuration, and major modes', () => {
    const template = DOOM_CONFIG_TEMPLATES['modes.yaml'];

    expect(template).toContain('# A layer is a reusable named bundle');
    expect(template).toContain("#       - './extensions/local-review.ts'");
    expect(template).toContain("#       - '@scope/review-extension'");
    expect(template).toContain('# A bare extension name selects a DoomPi built-in.');
    expect(template).toContain('# The top-level default bundle loads before every major mode.');
    expect(template).toContain('# packages list to customize the distribution defaults.');
    expect(template).toContain("      - name: '@agimon-ai/doompi-team'");
    expect(template).toContain('        # config:');
    expect(template).toContain('#     - model: openai-codex/gpt-5.6-luna');
    expect(template).toContain('#   excludeTools: [ask_user_question, intercom, subagent]');
    expect(template).toContain('doompi --major-mode <name>');
    expect(template).toContain('description: General-purpose coding mode');
    expect(template).toContain('# review:');
    expect(template).toContain('#   description: Focused review mode');
  });

  it('documents how to add and combine domains', () => {
    const template = DOOM_CONFIG_TEMPLATES['domains.yaml'];

    expect(template).toContain('# Plugins are named once in this catalog');
    expect(template).toContain('# use roots: [plugins] to discover a repository plugin folder');
    expect(template).toContain('plugins:\n  roots: []\n  entries: {}');
    expect(template).toContain('#     source: url');
    expect(template).toContain('#     - name: remote-review');
    expect(template).toContain('#       skills: [typescript]');
    expect(template).toContain('doompi --domains development');
    expect(template).toContain('#   work: [default, development]');
    expect(parseYaml(template)).toMatchObject({
      defaultDomains: ['default'],
      plugins: { roots: [], entries: {} },
      domains: { default: { description: 'Shared skills and repository MCP only.', plugins: [] } },
    });
  });

  it('offers the domain mcp allowlist as an example that parses when uncommented', () => {
    const template = DOOM_CONFIG_TEMPLATES['domains.yaml'];
    const lines = template.split('\n');
    const start = lines.findIndex((line) => line.startsWith('  # development:'));
    const end = lines.findIndex((line) => line.includes('proxy: [repository-search]'));

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // Only the development block is uncommented: the surrounding prose comments
    // are not YAML and would not parse.
    const uncommented = ['domains:', ...lines.slice(start, end + 1).map((line) => line.replace('# ', ''))].join('\n');

    expect(parseYaml(uncommented)).toMatchObject({
      domains: {
        development: {
          sharedSkills: false,
          plugins: ['development', { name: 'remote-review', mcp: true }],
          mcp: { servers: ['code-intel'], proxy: ['repository-search'] },
        },
      },
    });
  });

  it('documents how to discover, override, and select profiles', () => {
    const template = DOOM_CONFIG_TEMPLATES['profiles.yaml'];

    expect(template).toContain('# Each configured root may itself be a profile');
    expect(template).toContain('# AGENTS.md; discovery never scans recursively.');
    expect(template).toContain('# roots: [agents/acme]');
    expect(template).toContain('#     persona: agents/special/writer');
    expect(template).toContain('#       BRAND: acme');
    expect(template).toContain('# Select one with: doompi --profile writer');
    expect(parseYaml(template)).toEqual({ profiles: { roots: [], entries: {} } });
  });

  it('creates the canonical four seed files in order with exact bytes', () => {
    const home = temporaryHome();

    const result = initializeGlobalDoomConfig(home);
    const directory = globalDoomConfigDirectory(home);

    expect(result).toEqual({
      directory,
      created: [...GLOBAL_DOOM_SEED_FILES],
      preserved: [],
      replaced: [],
    });
    expect(fs.existsSync(path.join(home, '.pi', 'doom'))).toBe(false);
    expect(fs.readdirSync(directory)).toEqual(
      [...GLOBAL_DOOM_SEED_FILES].sort((left, right) => left.localeCompare(right)),
    );
    for (const fileName of GLOBAL_DOOM_SEED_FILES) {
      expect(fs.readFileSync(path.join(directory, fileName), 'utf8')).toBe(DOOM_CONFIG_TEMPLATES[fileName]);
    }
  });

  it('seeds only configurable public layer packages', () => {
    const source = DOOM_CONFIG_TEMPLATES['modes.yaml'];
    const document = parseYaml(source) as MajorModesDocument;

    expect(document.default.packages).toEqual(DEFAULT_DISTRIBUTION_PACKAGES);
    expect(Object.keys(document.layers)).toEqual(Object.keys(DEFAULT_LAYER_PACKAGES));
    for (const [layer, packageName] of Object.entries(DEFAULT_LAYER_PACKAGES)) {
      const packages = document.layers[layer]?.packages;
      expect(
        packages?.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
        layer,
      ).toEqual([packageName]);
    }
    expect(document.majorMode).toEqual({
      minimal: {
        description: 'Lean mode with Team delegation and persistent tasks.',
        layers: MINIMAL_DEFAULT_LAYERS,
      },
      copilot: {
        description:
          'General-purpose coding mode with Team delegation, persistent tasks, supervised commands, and structured user feedback.',
        layers: COPILOT_DEFAULT_LAYERS,
      },
    });
    for (const majorMode of MAJOR_MODES) {
      const packages = [...document.default.packages, ...packagesForMajorMode(source, majorMode)].map((entry) =>
        typeof entry === 'string' ? entry : entry.name,
      );
      expect(packages.length, majorMode).toBeGreaterThan(0);
      for (const name of packages) {
        // A seeded layer has to resolve for whoever ran `doompi init`.
        expect(
          PRIVATE_SCOPES.some((scope) => name.startsWith(scope)),
          name,
        ).toBe(false);
        expect(name.startsWith('@'), name).toBe(true);
      }
    }
  });

  it('preserves existing files and fills only missing files', () => {
    const home = temporaryHome();
    const directory = globalDoomConfigDirectory(home);
    fs.mkdirSync(directory, { recursive: true });
    const existingPath = path.join(directory, 'config.yaml');
    const existingContent = 'projectTrust: never\n';
    fs.writeFileSync(existingPath, existingContent, { mode: 0o640 });
    const existingMode = fs.statSync(existingPath).mode & 0o777;

    const first = initializeGlobalDoomConfig(home);
    const second = initializeGlobalDoomConfig(home);

    expect(first.created).toEqual([...GLOBAL_DOOM_SEED_FILES].slice(1));
    expect(first.preserved).toEqual(['config.yaml']);
    expect(second.created).toEqual([]);
    expect(second.preserved).toEqual([...GLOBAL_DOOM_SEED_FILES]);
    expect(fs.readFileSync(existingPath, 'utf8')).toBe(existingContent);
    expect(fs.statSync(existingPath).mode & 0o777).toBe(existingMode);
    expect(fs.readdirSync(directory).some((fileName) => fileName.endsWith('.tmp'))).toBe(false);
  });

  it('overwrites existing seed files only when forced', () => {
    const home = temporaryHome();
    const directory = globalDoomConfigDirectory(home);
    fs.mkdirSync(directory, { recursive: true });
    const existingPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(existingPath, 'projectTrust: never\n');

    const forced = initializeGlobalDoomConfig(home, { force: true });

    expect(forced.replaced).toEqual(['config.yaml']);
    expect(forced.created).toEqual([...GLOBAL_DOOM_SEED_FILES].slice(1));
    expect(forced.preserved).toEqual([]);
    expect(fs.readFileSync(existingPath, 'utf8')).toBe(DOOM_CONFIG_TEMPLATES['config.yaml']);
    expect(fs.statSync(existingPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory).some((fileName) => fileName.endsWith('.tmp'))).toBe(false);
  });

  it('rejects non-file target collisions and cleans temporary files', () => {
    const home = temporaryHome();
    const directory = globalDoomConfigDirectory(home);
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directory, 'modes.yaml'));

    expect(() => initializeGlobalDoomConfig(home)).toThrow('not file-like');
    expect(fs.readdirSync(directory)).toEqual(['config.yaml', 'modes.yaml']);
  });

  it('cleans temporary files when publication fails while writing', () => {
    const home = temporaryHome();
    const directory = globalDoomConfigDirectory(home);
    fs.mkdirSync(directory, { recursive: true });
    const writeFile = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('simulated write failure');
    });

    expect(() => initializeGlobalDoomConfig(home)).toThrow('simulated write failure');
    writeFile.mockRestore();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('keeps existing directory modes unchanged and creates private entries on POSIX', () => {
    if (process.platform === 'win32') return;
    const home = temporaryHome();
    const piDirectory = path.join(home, '.pi');
    const doomDirectory = path.join(piDirectory, '.doom');
    fs.mkdirSync(doomDirectory, { recursive: true, mode: 0o755 });
    fs.chmodSync(piDirectory, 0o751);
    fs.chmodSync(doomDirectory, 0o753);
    const piMode = fs.statSync(piDirectory).mode & 0o777;
    const doomMode = fs.statSync(doomDirectory).mode & 0o777;

    initializeGlobalDoomConfig(home);

    expect(fs.statSync(piDirectory).mode & 0o777).toBe(piMode);
    expect(fs.statSync(doomDirectory).mode & 0o777).toBe(doomMode);
    for (const fileName of GLOBAL_DOOM_SEED_FILES) {
      expect(fs.statSync(path.join(doomDirectory, fileName)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects symlinked config directories', () => {
    if (process.platform === 'win32') return;
    const home = temporaryHome();
    const outside = temporaryHome();
    fs.mkdirSync(path.join(home, '.pi'));
    fs.symlinkSync(outside, path.join(home, '.pi', '.doom'), 'dir');

    expect(() => initializeGlobalDoomConfig(home)).toThrow('symlinked directory');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('initializeRepositoryDoomConfig', () => {
  it('creates standalone repository seed files without creating .pi', () => {
    const repositoryRoot = temporaryHome();
    const directory = path.join(repositoryRoot, '.doom');

    expect(initializeRepositoryDoomConfig(repositoryRoot)).toEqual({
      directory,
      created: [...GLOBAL_DOOM_SEED_FILES],
      preserved: [],
      replaced: [],
    });
    expect(fs.existsSync(path.join(repositoryRoot, '.pi'))).toBe(false);
    for (const fileName of GLOBAL_DOOM_SEED_FILES) {
      expect(fs.readFileSync(path.join(directory, fileName), 'utf8')).toBe(REPOSITORY_DOOM_CONFIG_TEMPLATES[fileName]);
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(directory, fileName)).mode & 0o777).toBe(0o644);
      }
    }
    expect(parseYaml(REPOSITORY_DOOM_CONFIG_TEMPLATES['modes.yaml'])).toMatchObject({
      default: { packages: DEFAULT_DISTRIBUTION_PACKAGES },
      defaultMajorMode: 'copilot',
      layers: Object.fromEntries(
        Object.entries(DEFAULT_LAYER_PACKAGES).map(([layer, packageName]) => [
          layer,
          { packages: layer === 'team' ? [{ name: packageName }] : [packageName] },
        ]),
      ),
      majorMode: {
        minimal: {
          layers: MINIMAL_DEFAULT_LAYERS,
        },
        copilot: {
          layers: COPILOT_DEFAULT_LAYERS,
        },
      },
    });
  });

  it('preserves repository edits unless force is explicit', () => {
    const repositoryRoot = temporaryHome();
    const configPath = path.join(repositoryRoot, '.doom', 'config.yaml');
    initializeRepositoryDoomConfig(repositoryRoot);
    fs.writeFileSync(configPath, 'projectTrust: never\n');

    const preserved = initializeRepositoryDoomConfig(repositoryRoot);
    expect(preserved.preserved).toEqual([...GLOBAL_DOOM_SEED_FILES]);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('projectTrust: never\n');

    const forced = initializeRepositoryDoomConfig(repositoryRoot, { force: true });
    expect(forced.replaced).toEqual([...GLOBAL_DOOM_SEED_FILES]);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(REPOSITORY_DOOM_CONFIG_TEMPLATES['config.yaml']);
  });
});
