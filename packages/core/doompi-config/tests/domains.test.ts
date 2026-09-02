import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  domainCompletionItems,
  domainCompletionPrefix,
  findPluginManifestPath,
  listDomainNames,
  loadDomains,
  resolvePluginDirectories,
  resolvePluginEntries,
  resolveSharedSkills,
} from '../src/exports/domains.ts';

const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

describe('domain configuration', () => {
  let root: string;
  /** Isolated home, so a developer's own plugin marketplaces never reach these tests. */
  let home: string;
  let globalDoom: string;

  function writeRepoDomains(contents: string): void {
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doom', 'domains.yaml'), contents);
  }

  function writeGlobalDomains(contents: string): void {
    fs.mkdirSync(globalDoom, { recursive: true });
    fs.writeFileSync(path.join(globalDoom, 'domains.yaml'), contents);
  }

  function writeMarketplace(
    marketplaceRoot: string,
    contents: Record<string, unknown>,
    layout = '.agents/plugins/marketplace.json',
  ): string {
    const filePath = path.join(marketplaceRoot, layout);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(contents));
    return filePath;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domains-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domains-home-'));
    globalDoom = path.join(home, '.pi', '.doom');
    fs.mkdirSync(path.join(root, 'plugins', 'one'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plugins', 'two'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('treats a workspace with no domains config as empty', () => {
    expect(loadDomains(root, home)).toEqual({
      plugins: { roots: [], marketplaces: [], entries: {}, diagnostics: [] },
      domains: {},
      aliases: {},
    });
    expect(listDomainNames(root, home)).toEqual([]);
  });

  it('loads multiple defaults and lets the repository replace global defaults', () => {
    writeGlobalDomains(
      'plugins: { roots: [], entries: {} }\ndefaultDomains: [shared]\ndomains:\n  shared:\n    description: Shared\n    plugins: []\naliases: {}\n',
    );
    expect(loadDomains(root, home).defaultDomains).toEqual(['shared']);

    writeRepoDomains(
      'plugins: { roots: [], entries: {} }\ndefaultDomains: [development, quality]\ndomains:\n  development:\n    description: Development\n    plugins: []\n  qa:\n    description: Quality\n    plugins: []\naliases:\n  quality: [qa]\n',
    );

    expect(loadDomains(root, home).defaultDomains).toEqual(['development', 'quality']);
  });

  it('allows an explicitly empty default domain list', () => {
    writeRepoDomains('plugins: { roots: [], entries: {} }\ndefaultDomains: []\ndomains: {}\naliases: {}\n');
    expect(loadDomains(root, home).defaultDomains).toEqual([]);
  });

  it.each([
    ['non-array', 'defaultDomains: default\ndomains: {}\n', 'must be an array'],
    ['blank', 'defaultDomains: [" "]\ndomains: {}\n', 'must be a non-empty string'],
    [
      'unknown',
      'defaultDomains: [missing]\ndomains:\n  default:\n    plugins: []\n',
      'Unknown default domain "missing"',
    ],
  ])('rejects %s configured default domains', (_name, contents, message) => {
    writeRepoDomains(contents);
    expect(() => loadDomains(root, home)).toThrow(message);
  });

  it('expands aliases and preserves plugin subset metadata', () => {
    writeRepoDomains(
      `plugins:
  entries:
    one: plugins/one
    two:
      path: plugins/two
domains:
  development:
    description: TypeScript development
    plugins:
      - name: one
        skills: [typescript]
        agents: [reviewer]
        hooks: false
        mcp: true
  qa:
    description: Quality assurance
    plugins: [two]
    sharedSkills: false
aliases:
  default: [development, qa]
`,
    );

    expect(listDomainNames(root, home)).toEqual(['default', 'development', 'qa']);
    expect(resolvePluginEntries(root, ['default'], [], home)).toEqual([
      {
        name: 'one',
        directory: path.join(root, 'plugins', 'one'),
        domain: 'development',
        source: { type: 'local', path: path.join(root, 'plugins', 'one') },
        skills: ['typescript'],
        agents: ['reviewer'],
        hooks: false,
        mcp: true,
      },
      {
        name: 'two',
        directory: path.join(root, 'plugins', 'two'),
        domain: 'qa',
        source: { type: 'local', path: path.join(root, 'plugins', 'two') },
      },
    ]);
    expect(resolveSharedSkills(root, ['qa'], home)).toBe(false);
    expect(resolveSharedSkills(root, ['development', 'qa'], home)).toBe(true);
    expect(resolveSharedSkills(root, [], home)).toBe(true);
  });

  it('resolves a named plugin path anywhere under the repository', () => {
    fs.mkdirSync(path.join(root, 'tools', 'bespoke'), { recursive: true });
    writeRepoDomains(
      'plugins:\n  entries:\n    bespoke: tools/bespoke\ndomains:\n  custom:\n    plugins: [bespoke]\naliases: {}\n',
    );
    expect(resolvePluginDirectories(root, ['custom'], [], home)).toEqual([path.join(root, 'tools', 'bespoke')]);
  });

  it('resolves a global entry against the global config directory', () => {
    fs.mkdirSync(path.join(globalDoom, 'plugins', 'shared'), { recursive: true });
    writeGlobalDomains(
      'plugins:\n  entries:\n    shared: plugins/shared\ndomains:\n  shared:\n    plugins: [shared]\naliases: {}\n',
    );
    expect(resolvePluginDirectories(root, ['shared'], [], home)).toEqual([path.join(globalDoom, 'plugins', 'shared')]);
  });

  it('lets repository domains and entries replace global names while inheriting the rest', () => {
    fs.mkdirSync(path.join(globalDoom, 'plugins', 'shared'), { recursive: true });
    writeGlobalDomains(
      'plugins:\n  entries:\n    shared: plugins/shared\ndomains:\n  shared:\n    plugins: [shared]\n  default:\n    plugins: [shared]\naliases:\n  everything: [shared, default]\n',
    );
    writeRepoDomains(
      'plugins:\n  entries:\n    repository: plugins/one\ndomains:\n  default:\n    plugins: [repository]\naliases: {}\n',
    );

    expect(listDomainNames(root, home)).toEqual(['default', 'everything', 'shared']);
    expect(resolvePluginDirectories(root, ['everything'], [], home)).toEqual([
      path.join(globalDoom, 'plugins', 'shared'),
      path.join(root, 'plugins', 'one'),
    ]);
  });

  it('merges home and repository plugin roots while preserving domains from both layers', () => {
    const homePlugin = path.join(globalDoom, 'home-plugins', 'shared-directory');
    const repoPlugin = path.join(root, 'repo-plugins', 'local-directory');
    fs.mkdirSync(path.join(homePlugin, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(repoPlugin, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(homePlugin, '.codex-plugin', 'plugin.json'), '{"name":"home-tool"}');
    fs.writeFileSync(path.join(repoPlugin, '.codex-plugin', 'plugin.json'), '{"name":"repo-tool"}');
    writeGlobalDomains(
      'plugins:\n  roots: [home-plugins]\ndomains:\n  shared:\n    plugins: [home-tool]\naliases: {}\n',
    );
    writeRepoDomains(
      'plugins:\n  roots: [repo-plugins]\ndomains:\n  default:\n    plugins: [repo-tool]\naliases: {}\n',
    );

    const manifest = loadDomains(root, home);
    expect(manifest.plugins.roots).toEqual([path.join(globalDoom, 'home-plugins'), path.join(root, 'repo-plugins')]);
    expect(listDomainNames(root, home)).toEqual(['default', 'shared']);
    expect(resolvePluginDirectories(root, ['shared', 'default'], [], home)).toEqual([homePlugin, repoPlugin]);
  });

  it('deduplicates domain and explicit plugin directories', () => {
    const explicit = path.join(root, 'plugins', 'explicit');
    fs.mkdirSync(explicit);
    writeRepoDomains(
      'plugins:\n  entries:\n    one: plugins/one\n    two: plugins/two\ndomains:\n  default:\n    plugins: [one, two]\n  overlap:\n    plugins: [two]\naliases: {}\n',
    );
    expect(resolvePluginDirectories(root, ['default', 'overlap'], [explicit, explicit], home)).toEqual([
      path.join(root, 'plugins', 'one'),
      path.join(root, 'plugins', 'two'),
      explicit,
    ]);
  });

  it('validates requested domains, named references, and local paths', () => {
    writeRepoDomains(
      'plugins:\n  entries:\n    broken: plugins/missing\ndomains:\n  broken:\n    plugins: [broken]\n  legacy:\n    plugins: [plugins/one]\naliases: {}\n',
    );
    expect(() => resolvePluginDirectories(root, ['missing'], [], home)).toThrow('Unknown domain: missing');
    expect(() => resolvePluginEntries(root, [], [path.join(root, 'missing')], home)).toThrow(
      'Plugin directory does not exist',
    );
    expect(() => resolvePluginEntries(root, ['broken'], [], home)).toThrow('Plugin directory does not exist');
    expect(() => resolvePluginEntries(root, ['legacy'], [], home)).toThrow('Unknown plugin "plugins/one"');
  });

  it('discovers personal and repository Codex marketplaces with first-marketplace precedence', () => {
    const personalPlugin = path.join(home, 'personal-plugin');
    fs.mkdirSync(personalPlugin);
    writeMarketplace(home, {
      name: 'shared',
      plugins: [{ name: 'tool', source: './personal-plugin', description: 'Personal tool' }],
    });
    writeMarketplace(root, {
      name: 'shared',
      plugins: [{ name: 'tool', source: './plugins/one', description: 'Repository tool' }],
    });
    writeRepoDomains('domains:\n  default:\n    plugins: [tool@shared]\naliases: {}\n');

    const manifest = loadDomains(root, home);
    expect(manifest.plugins.marketplaces).toEqual([
      path.join(home, '.agents', 'plugins', 'marketplace.json'),
      path.join(root, '.agents', 'plugins', 'marketplace.json'),
    ]);
    expect(manifest.plugins.entries['tool@shared']).toMatchObject({
      source: { type: 'local', path: personalPlugin },
      marketplace: 'shared',
      description: 'Personal tool',
    });
    expect(resolvePluginDirectories(root, ['default'], [], home)).toEqual([personalPlugin]);
  });

  it('discovers configured marketplace roots and lets explicit entries override catalog IDs', () => {
    const marketplaceRoot = path.join(root, 'vendor');
    fs.mkdirSync(path.join(marketplaceRoot, 'plugin'), { recursive: true });
    writeMarketplace(marketplaceRoot, {
      name: 'vendor',
      plugins: [{ name: 'tool', source: './plugin' }],
    });
    writeRepoDomains(
      `plugins:
  roots: [vendor]
  entries:
    tool@vendor: plugins/two
domains:
  default:
    plugins: [tool@vendor]
aliases: {}
`,
    );

    const manifest = loadDomains(root, home);
    expect(manifest.plugins.roots).toEqual([marketplaceRoot]);
    expect(manifest.plugins.entries['tool@vendor'].source).toEqual({
      type: 'local',
      path: path.join(root, 'plugins', 'two'),
    });
  });

  it('normalizes Codex git and npm sources into persistent cache entries', () => {
    writeRepoDomains(
      `plugins:
  entries:
    remote:
      source: url
      url: owner/repository
      path: plugins/remote
      ref: main
      sha: abc123
    package:
      source: npm
      package: '@scope/doom-plugin'
      version: 1.2.3
domains:
  default:
    plugins: [remote, package]
aliases: {}
`,
    );

    const manifest = loadDomains(root, home);
    expect(manifest.plugins.entries.remote?.source).toEqual({
      type: 'git',
      url: 'https://github.com/owner/repository.git',
      path: 'plugins/remote',
      ref: 'main',
      sha: 'abc123',
    });
    expect(manifest.plugins.entries.package?.source).toEqual({
      type: 'npm',
      package: '@scope/doom-plugin',
      version: '1.2.3',
    });
    const resolved = resolvePluginEntries(root, ['default'], [], home);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.directory.startsWith(path.join(globalDoom, 'plugin-cache')))).toBe(true);
    expect(resolved[0]?.directory).not.toBe(resolved[1]?.directory);
  });

  it('accepts canonical local, nested, and git-subdir entry source forms', () => {
    writeRepoDomains(
      `plugins:
  entries:
    local:
      source: local
      path: plugins/one
      description: Local plugin
    nested:
      source:
        source: local
        path: plugins/two
    subdirectory:
      source: git-subdir
      url: https://example.com/plugins.git
      path: packages/tool
domains:
  default:
    plugins: [local, nested, subdirectory]
aliases: {}
`,
    );

    const catalog = loadDomains(root, home).plugins;
    expect(catalog.entries.local).toMatchObject({
      source: { type: 'local', path: path.join(root, 'plugins', 'one') },
      description: 'Local plugin',
    });
    expect(catalog.entries.nested?.source).toEqual({ type: 'local', path: path.join(root, 'plugins', 'two') });
    expect(catalog.entries.subdirectory?.source).toEqual({
      type: 'git',
      url: 'https://example.com/plugins.git',
      path: 'packages/tool',
    });
  });

  it('keeps relative Git URLs inside the declaring configuration root', () => {
    writeRepoDomains(
      `plugins:
  entries:
    remote:
      source: url
      url: ./remotes/plugin.git
domains:
  default:
    plugins: [remote]
`,
    );
    expect(loadDomains(root, home).plugins.entries.remote?.source).toEqual({
      type: 'git',
      url: path.join(root, 'remotes', 'plugin.git'),
    });

    writeRepoDomains(
      `plugins:
  entries:
    escaped:
      source: url
      url: ./../plugin.git
domains: {}
`,
    );
    expect(() => loadDomains(root, home)).toThrow('must stay within its declaring root');
  });

  it('uses the first supported marketplace layout and reports configured roots without one', () => {
    writeMarketplace(root, { name: 'agents', plugins: [{ name: 'tool', source: './plugins/one' }] });
    writeMarketplace(
      root,
      { name: 'claude', plugins: [{ name: 'ignored', source: './plugins/two' }] },
      '.claude-plugin/marketplace.json',
    );
    writeRepoDomains('plugins:\n  roots: [missing-marketplace]\ndomains: {}\naliases: {}\n');

    const catalog = loadDomains(root, home).plugins;
    expect(catalog.marketplaces).toEqual([path.join(root, '.agents', 'plugins', 'marketplace.json')]);
    expect(catalog.entries['tool@agents']).toBeDefined();
    expect(catalog.entries['ignored@claude']).toBeUndefined();
    expect(catalog.diagnostics).toContain(
      `Plugin root contains neither a supported marketplace nor discoverable plugins: ${path.join(root, 'missing-marketplace')}`,
    );
  });

  it('discovers every direct-child plugin from a configured folder root', () => {
    const pluginFolder = path.join(root, 'plugin-folder');
    const alpha = path.join(pluginFolder, 'alpha-directory');
    const beta = path.join(pluginFolder, 'beta-directory');
    const nested = path.join(pluginFolder, 'group', 'nested');
    fs.mkdirSync(path.join(alpha, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(beta, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(nested, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(alpha, '.codex-plugin', 'plugin.json'), '{"name":"alpha"}');
    fs.writeFileSync(path.join(beta, '.claude-plugin', 'plugin.json'), '{"name":"beta"}');
    fs.writeFileSync(path.join(nested, '.codex-plugin', 'plugin.json'), '{"name":"nested"}');
    writeRepoDomains(
      'plugins:\n  roots: [plugin-folder]\ndomains:\n  default:\n    plugins: [alpha, beta]\naliases: {}\n',
    );

    const manifest = loadDomains(root, home);
    expect(Object.keys(manifest.plugins.entries)).toEqual(['alpha', 'beta']);
    expect(resolvePluginDirectories(root, ['default'], [], home)).toEqual([alpha, beta]);
  });

  it('accepts a configured root that is itself one plugin and falls back to its directory name', () => {
    const pluginRoot = path.join(root, 'standalone-tool');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), '{}');
    writeRepoDomains(
      'plugins:\n  roots: [standalone-tool]\ndomains:\n  default:\n    plugins: [standalone-tool]\naliases: {}\n',
    );

    expect(resolvePluginDirectories(root, ['default'], [], home)).toEqual([pluginRoot]);
  });

  it('uses Agent Plugin and legacy manifest precedence', () => {
    const pluginRoot = path.join(root, 'plugins', 'one');
    const rootManifest = path.join(pluginRoot, 'plugin.json');
    const codexManifest = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const claudeManifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    fs.mkdirSync(path.dirname(codexManifest), { recursive: true });
    fs.mkdirSync(path.dirname(claudeManifest), { recursive: true });
    fs.writeFileSync(codexManifest, '{"name":"codex"}');
    fs.writeFileSync(claudeManifest, '{"name":"claude"}');
    fs.writeFileSync(rootManifest, '{"name":"unrelated-package"}');
    expect(findPluginManifestPath(pluginRoot)).toBe(codexManifest);

    fs.writeFileSync(rootManifest, JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: 'portable' }));
    expect(findPluginManifestPath(pluginRoot)).toBe(rootManifest);
    writeRepoDomains(
      'plugins:\n  entries:\n    portable: plugins/one\ndomains:\n  default:\n    plugins: [portable]\n',
    );
    const [resolved] = resolvePluginEntries(root, ['default'], [], home);
    expect(resolved?.skillDiscovery).toBe('direct-children');
    expect(resolved?.manifest).toMatchObject({ path: rootManifest, agentPluginSchema: AGENT_PLUGIN_SCHEMA });
  });

  it('keeps invalid automatic marketplace entries as diagnostics instead of failing config loading', () => {
    writeMarketplace(root, {
      name: 'repository',
      plugins: [
        { name: 'valid', source: './plugins/one' },
        { name: 'invalid', source: './plugins/../outside' },
      ],
    });
    writeRepoDomains('domains: {}\naliases: {}\n');

    const catalog = loadDomains(root, home).plugins;
    expect(catalog.entries['valid@repository']).toBeDefined();
    expect(catalog.entries['invalid@repository']).toBeUndefined();
    expect(catalog.diagnostics.join('\n')).toContain('must stay within the marketplace root');
  });

  it('validates plugin catalog and named selection shapes', () => {
    writeRepoDomains('plugins:\n  roots: vendor\ndomains: {}\n');
    expect(() => loadDomains(root, home)).toThrow('plugins.roots');

    writeRepoDomains('plugins: {}\ndomains:\n  bad:\n    plugins:\n      - dir: plugins/one\n');
    expect(() => loadDomains(root, home)).toThrow('unsupported field "dir"');
  });

  it('completes only the current domains command token', () => {
    expect(domainCompletionPrefix('/domains qa,dev')).toBe('dev');
    expect(domainCompletionPrefix('/model gpt')).toBeUndefined();
    expect(domainCompletionItems(['default', 'development', 'qa'], 'dev')).toEqual([
      { value: 'development', label: 'development' },
    ]);
  });
});
