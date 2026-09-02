import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompatibilityOptions } from '../../src/types/interfaces/compatibility';
import { buildCompatibilityContext } from '../../src/exports/services/compatibilityContext';

const LAYERS_YAML = [
  'layers:',
  '  guardrails:',
  '    extensions: [repositoryHooks]',
  '    hookGroups: [guardrails]',
  '  team:',
  "    packages: ['@agimon-ai/doompi-team']",
  'majorMode:',
  '  copilot: [guardrails, team]',
  '  minimal: []',
  '',
].join('\n');

function writeRepository(root: string, overrides: { domainsYaml?: string; mcpJson?: unknown } = {}): void {
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'shared', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), LAYERS_YAML);
  fs.writeFileSync(
    path.join(root, '.doom', 'domains.yaml'),
    overrides.domainsYaml ??
      [
        'plugins:',
        '  entries:',
        '    shared: plugins/shared',
        'domains:',
        '  default:',
        '    plugins: [shared]',
        'aliases: {}',
        '',
      ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, '.doom', 'profiles.yaml'),
    ['profiles:', '  product:', '    persona: agents/acme/pat', '    env:', '      ACME_TOKEN: from-profile', ''].join(
      '\n',
    ),
  );
  fs.mkdirSync(path.join(root, 'agents', 'acme', 'pat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'acme', 'pat', 'profile.md'), 'Pat builds things.\n');
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(overrides.mcpJson ?? { mcpServers: {} }, null, 2));
}

function baseOptions(root: string, overrides: Partial<CompatibilityOptions> = {}): CompatibilityOptions {
  return {
    repoRoot: root,
    currentDirectory: root,
    provider: 'claude',
    domains: ['default'],
    majorMode: 'copilot',
    providerArgs: [],
    additionalDirectories: [],
    skipPermissions: false,
    ...overrides,
  };
}

describe('buildCompatibilityContext', () => {
  let root: string;
  let inheritedOriginalRepoPath: string | undefined;

  beforeEach(() => {
    inheritedOriginalRepoPath = process.env.ORIGINAL_REPO_PATH;
    delete process.env.ORIGINAL_REPO_PATH;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-compat-context-'));
    writeRepository(root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (inheritedOriginalRepoPath === undefined) delete process.env.ORIGINAL_REPO_PATH;
    else process.env.ORIGINAL_REPO_PATH = inheritedOriginalRepoPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves layers, plugins, and a private run directory', async () => {
    const context = await buildCompatibilityContext(baseOptions(root));

    expect(context.selectedLayers).toEqual(['guardrails', 'team']);
    expect(context.hookGroups).toEqual(['guardrails']);
    expect(context.plugins).toEqual([
      {
        name: 'shared',
        directory: path.join(root, 'plugins', 'shared'),
        domain: 'default',
        source: { type: 'local', path: path.join(root, 'plugins', 'shared') },
      },
    ]);
    expect(context.sharedSkills).toBe(true);
    expect(fs.existsSync(context.mcpConfigPath)).toBe(true);
    expect(fs.statSync(path.dirname(context.mcpConfigPath)).mode & 0o777).toBe(0o700);

    await context.cleanup();
    expect(fs.existsSync(context.mcpConfigPath)).toBe(false);
  });

  it('exports the repository root under every frontend variable', async () => {
    const context = await buildCompatibilityContext(
      baseOptions(root, { additionalDirectories: ['/shared', '/other'] }),
    );

    expect(context.environment.CLAUDE_PROJECT_DIR).toBe(root);
    expect(context.environment.CODEX_REPO_ROOT).toBe(root);
    expect(context.environment.AGY_REPO_ROOT).toBe(root);
    expect(context.environment.ORIGINAL_REPO_PATH).toBe(root);
    expect(context.environment.DOOMPI_ADDITIONAL_DIRS).toBe(['/shared', '/other'].join(path.delimiter));

    await context.cleanup();
  });

  it('defaults Nx daemon use off for an ephemeral compatibility session', async () => {
    const inherited = process.env.NX_DAEMON;
    delete process.env.NX_DAEMON;
    const context = await buildCompatibilityContext(baseOptions(root));
    try {
      expect(context.environment.NX_DAEMON).toBe('false');
    } finally {
      await context.cleanup();
      if (inherited === undefined) delete process.env.NX_DAEMON;
      else process.env.NX_DAEMON = inherited;
    }
  });

  it('preserves an explicit Nx daemon override', async () => {
    vi.stubEnv('NX_DAEMON', 'true');
    const context = await buildCompatibilityContext(baseOptions(root));

    expect(context.environment.NX_DAEMON).toBe('true');

    await context.cleanup();
  });

  it('keeps an inherited original repository path', async () => {
    vi.stubEnv('ORIGINAL_REPO_PATH', '/outer/repo');

    const context = await buildCompatibilityContext(baseOptions(root));

    expect(context.environment.ORIGINAL_REPO_PATH).toBe('/outer/repo');

    await context.cleanup();
  });

  it('writes the persona and applies profile environment defaults', async () => {
    const context = await buildCompatibilityContext(baseOptions(root, { profile: 'product' }));

    expect(context.profile?.name).toBe('product');
    expect(context.personaFile).toBeDefined();
    expect(fs.readFileSync(context.personaFile ?? '', 'utf8')).toContain('Pat builds things.');
    expect(context.environment.ACME_TOKEN).toBe('from-profile');

    await context.cleanup();
  });

  it('leaves an exported value in place of the profile default', async () => {
    vi.stubEnv('ACME_TOKEN', 'from-shell');

    const context = await buildCompatibilityContext(baseOptions(root, { profile: 'product' }));

    expect(context.environment.ACME_TOKEN).toBe('from-shell');

    await context.cleanup();
  });

  it('writes no persona file when no profile is selected', async () => {
    const context = await buildCompatibilityContext(baseOptions(root));

    expect(context.profile).toBeUndefined();
    expect(context.personaFile).toBeUndefined();

    await context.cleanup();
  });

  it('rejects a profile whose persona directory holds no readable file', async () => {
    fs.rmSync(path.join(root, 'agents', 'acme', 'pat', 'profile.md'));

    await expect(buildCompatibilityContext(baseOptions(root, { profile: 'product' }))).rejects.toThrow(
      'has no readable persona files',
    );
  });

  it('defaults the proxy config path when no proxy server declares one', async () => {
    const context = await buildCompatibilityContext(baseOptions(root));

    expect(context.proxyConfigPath).toBe(path.join(root, 'mcp-config.yaml'));

    await context.cleanup();
  });

  it('takes the proxy config path from the proxy server arguments', async () => {
    writeRepository(root, {
      mcpJson: {
        mcpServers: {
          'agiflow-proxy': { command: 'npx', args: ['@agimon-ai/mcp-proxy', '--config', 'config/proxy.yaml'] },
        },
      },
    });

    const context = await buildCompatibilityContext(baseOptions(root));

    expect(context.proxyConfigPath).toBe(path.join(root, 'config', 'proxy.yaml'));

    await context.cleanup();
  });

  it('honours a plugin that opts out of contributing MCP servers', async () => {
    fs.writeFileSync(
      path.join(root, 'plugins', 'shared', '.mcp.json'),
      JSON.stringify({ mcpServers: { 'shared-mcp': { command: 'shared' } } }),
    );
    writeRepository(root, {
      domainsYaml: [
        'plugins:',
        '  entries:',
        '    shared: plugins/shared',
        'domains:',
        '  default:',
        '    plugins:',
        '      - name: shared',
        '        mcp: false',
        'aliases: {}',
        '',
      ].join('\n'),
    });

    const context = await buildCompatibilityContext(baseOptions(root));
    const config = JSON.parse(fs.readFileSync(context.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(config.mcpServers)).not.toContain('shared-mcp');

    await context.cleanup();
  });

  it('normalizes an Agent Plugin root mcp.json for compatibility frontends', async () => {
    const plugin = path.join(root, 'plugins', 'shared');
    fs.writeFileSync(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' }),
    );
    fs.writeFileSync(
      path.join(plugin, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          portable: { type: 'streamable-http', url: 'https://mcp.example.test' },
        },
      }),
    );
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { legacy: { command: 'legacy' } } }));

    const context = await buildCompatibilityContext(baseOptions(root));
    const config = JSON.parse(fs.readFileSync(context.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };

    expect(config.mcpServers).toEqual({
      portable: { type: 'http', url: 'https://mcp.example.test' },
    });
    await context.cleanup();
  });

  it('applies a domain MCP allowlist to the generated config', async () => {
    writeRepository(root, {
      domainsYaml: [
        'plugins:',
        '  entries:',
        '    shared: plugins/shared',
        'domains:',
        '  default:',
        '    plugins: [shared]',
        '    mcp:',
        '      servers: [keep-me]',
        'aliases: {}',
        '',
      ].join('\n'),
      mcpJson: { mcpServers: { 'keep-me': { command: 'keep' }, 'drop-me': { command: 'drop' } } },
    });

    const context = await buildCompatibilityContext(baseOptions(root));
    const config = JSON.parse(fs.readFileSync(context.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };

    expect(context.mcpAllowlist).toEqual({ servers: ['keep-me'], proxy: [] });
    expect(Object.keys(config.mcpServers)).toEqual(['keep-me']);

    await context.cleanup();
  });

  it('removes the run directory when preparation fails', async () => {
    // Counted in a private temp root rather than the shared one. Sibling test
    // files build their own compatibility contexts concurrently, and every one
    // of those is also named `doom-pi-compat-*`, so counting the real temp
    // directory measures whatever else happens to be running.
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-compat-isolated-'));
    vi.stubEnv('TMPDIR', temporaryRoot);
    const runDirectories = (): number =>
      fs.readdirSync(temporaryRoot).filter((entry) => entry.startsWith('doom-pi-compat-')).length;

    try {
      expect(runDirectories()).toBe(0);

      await expect(buildCompatibilityContext(baseOptions(root, { profile: 'missing-profile' }))).rejects.toThrow();

      expect(runDirectories()).toBe(0);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('fails for a layer base that is not declared', async () => {
    await expect(buildCompatibilityContext(baseOptions(root, { majorMode: 'nope' }))).rejects.toThrow(
      'Unknown major mode: nope',
    );
  });
});
