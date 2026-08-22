import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompatibilityOptions } from '../../src/types/interfaces/compatibility';
import {
  adaptAntigravityMcpDefinition,
  antigravityCompatibilityArgs,
  claudeCompatibilityArgs,
  codexCompatibilityArgs,
  launchCompatibility,
  signalExitCode,
  supportsCodexManagedProfile,
} from '../../src/adapters/compatibility';
import type { CompatibilityContext } from '../../src/adapters/compatibilityContext';

function baseOptions(overrides: Partial<CompatibilityOptions> = {}): CompatibilityOptions {
  return {
    repoRoot: '/repo',
    currentDirectory: '/worktree',
    provider: 'claude',
    domains: ['marketing'],
    majorMode: 'copilot',
    providerArgs: ['prompt'],
    additionalDirectories: ['/shared'],
    skipPermissions: false,
    ...overrides,
  };
}

function baseContext(overrides: Partial<CompatibilityContext> = {}): CompatibilityContext {
  return {
    options: baseOptions(),
    environment: {},
    plugins: [{ directory: '/repo/plugins/product-marketing' }],
    mcpAllowlist: { servers: ['agiflow-proxy'] },
    mcpConfigPath: '/tmp/mcp.json',
    proxyConfigPath: '/tmp/mcp-config.yaml',
    selectedLayers: ['guardrails'],
    hookGroups: ['guardrails'],
    sharedSkills: true,
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFakeAgy(root: string): string {
  const binDirectory = path.join(root, 'bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(path.join(binDirectory, 'agy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
}

function antigravityContext(
  repoRoot: string,
  home: string,
  executablePath: string,
  overrides: Partial<CompatibilityContext> = {},
): CompatibilityContext {
  const mcpConfigPath = path.join(repoRoot, 'selected-mcp.json');
  writeJson(mcpConfigPath, { mcpServers: {} });
  return baseContext({
    options: baseOptions({
      repoRoot,
      currentDirectory: repoRoot,
      provider: 'antigravity',
      domains: ['default'],
      providerArgs: [],
      additionalDirectories: [],
    }),
    environment: { HOME: home, PATH: executablePath },
    plugins: [],
    mcpAllowlist: { servers: ['agiflow-proxy'] },
    mcpConfigPath,
    proxyConfigPath: path.join(repoRoot, 'mcp-config.yaml'),
    sharedSkills: false,
    ...overrides,
  });
}

describe('compatibility launcher arguments', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    vi.clearAllMocks();
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-compat-test-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('builds Claude arguments from domains, MCP scope, profile persona, and inherited directories', () => {
    const personaFile = path.join(temporaryDirectory, 'persona.md');
    fs.writeFileSync(personaFile, 'Persona');
    const context = baseContext({ personaFile, options: baseOptions({ skipPermissions: true }) });

    expect(claudeCompatibilityArgs(context)).toEqual([
      '--dangerously-skip-permissions',
      '--plugin-dir',
      '/repo/plugins/product-marketing',
      '--mcp-config',
      '/tmp/mcp.json',
      '--strict-mcp-config',
      '--append-system-prompt-file',
      personaFile,
      '--add-dir',
      '/shared',
      'prompt',
    ]);
  });

  describe('permission prompts', () => {
    // The bypass disables the frontend's own approval gate, so the default has
    // to be "leave it alone". These assert the default per provider rather than
    // trusting one shared code path, because each provider spells the flag
    // differently and they are built in three separate functions.
    it('leaves Claude approval prompts alone unless the run asks for the bypass', () => {
      expect(claudeCompatibilityArgs(baseContext())).not.toContain('--dangerously-skip-permissions');
    });

    it('leaves Codex approval prompts alone unless the run asks for the bypass', () => {
      const context = baseContext({ options: baseOptions({ provider: 'codex' }) });

      expect(codexCompatibilityArgs(context, 'agirepo_profile', '--profile-v2')).not.toContain('--yolo');
    });

    it('leaves Antigravity approval prompts alone unless the run asks for the bypass', () => {
      const context = baseContext({ options: baseOptions({ provider: 'antigravity' }) });

      expect(antigravityCompatibilityArgs(context)).not.toContain('--dangerously-skip-permissions');
    });

    it('bypasses each provider only when skipPermissions is set', () => {
      const claude = baseContext({ options: baseOptions({ skipPermissions: true }) });
      const codex = baseContext({ options: baseOptions({ provider: 'codex', skipPermissions: true }) });
      const antigravity = baseContext({ options: baseOptions({ provider: 'antigravity', skipPermissions: true }) });

      expect(claudeCompatibilityArgs(claude)).toContain('--dangerously-skip-permissions');
      expect(codexCompatibilityArgs(codex, 'agirepo_profile', '--profile-v2')).toContain('--yolo');
      expect(antigravityCompatibilityArgs(antigravity)).toContain('--dangerously-skip-permissions');
    });
  });

  it('leaves Claude repository MCP discovery unchanged for unscoped domains', () => {
    const context = baseContext({ mcpAllowlist: undefined });

    expect(claudeCompatibilityArgs(context)).not.toContain('--strict-mcp-config');
  });

  it('layers the managed Codex profile, persona, and scoped proxy before caller arguments', () => {
    const personaFile = path.join(temporaryDirectory, 'persona.md');
    fs.writeFileSync(personaFile, 'Persona instructions\n');
    const context = baseContext({
      personaFile,
      options: baseOptions({
        provider: 'codex',
        providerArgs: ['-c', 'developer_instructions="caller"', 'prompt'],
        skipPermissions: true,
      }),
    });

    const args = codexCompatibilityArgs(context, 'agirepo_profile', '--profile-v2');

    expect(args.slice(0, 7)).toEqual([
      '--yolo',
      '--enable',
      'hooks',
      '--add-dir',
      '/shared',
      '--profile-v2',
      'agirepo_profile',
    ]);
    expect(args).toContain('-c');
    expect(args.find((argument) => argument.startsWith('developer_instructions='))).toContain('Persona instructions');
    expect(args.find((argument) => argument.startsWith('mcp_servers.agiflow-proxy.args='))).toContain(
      '/tmp/mcp-config.yaml',
    );
    expect(args.slice(-3)).toEqual(['-c', 'developer_instructions="caller"', 'prompt']);
  });

  it('does not inject managed session options into Codex management subcommands', () => {
    const context = baseContext({
      personaFile: path.join(temporaryDirectory, 'persona.md'),
      options: baseOptions({ provider: 'codex', providerArgs: ['login'] }),
    });
    fs.writeFileSync(context.personaFile!, 'Persona');

    const args = codexCompatibilityArgs(context, 'agirepo_profile', '--profile');

    expect(args).not.toContain('--profile');
    expect(args.some((argument) => argument.startsWith('developer_instructions='))).toBe(false);
    expect(args.at(-1)).toBe('login');
  });

  it('passes Antigravity arguments through with inherited directories', () => {
    const context = baseContext({
      options: baseOptions({
        provider: 'antigravity',
        providerArgs: ['--effort', 'high', '--print', 'prompt'],
        skipPermissions: true,
      }),
    });

    expect(antigravityCompatibilityArgs(context)).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/shared',
      '--effort',
      'high',
      '--print',
      'prompt',
    ]);
  });

  it('maps child termination signals to conventional exit codes', () => {
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGQUIT')).toBe(131);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode(null)).toBe(1);
  });

  it('preserves Antigravity command MCP environment and working-directory fields', () => {
    expect(
      adaptAntigravityMcpDefinition(
        {
          type: 'stdio',
          command: 'node',
          args: [1, 'server.mjs'],
          cwd: '/custom',
          env: { TOKEN: 'secret' },
          timeout: 5_000,
        },
        '/repo',
      ),
    ).toEqual({
      command: 'node',
      args: ['1', 'server.mjs'],
      cwd: '/custom',
      env: { TOKEN: 'secret' },
      timeout: 5_000,
    });
    expect(adaptAntigravityMcpDefinition({ command: 'node' }, '/repo')).toMatchObject({ cwd: '/repo' });
    expect(
      adaptAntigravityMcpDefinition(
        { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
        '/repo',
      ),
    ).toEqual({ serverUrl: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } });
  });

  it('serializes concurrent Antigravity state updates across repositories', async () => {
    const home = path.join(temporaryDirectory, 'home');
    const executablePath = createFakeAgy(temporaryDirectory);
    const firstRepo = path.join(temporaryDirectory, 'first-repo');
    const secondRepo = path.join(temporaryDirectory, 'second-repo');
    const exitCodes = await Promise.all([
      launchCompatibility(antigravityContext(firstRepo, home, executablePath)),
      launchCompatibility(antigravityContext(secondRepo, home, executablePath)),
    ]);

    expect(exitCodes).toEqual([0, 0]);
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'),
    ) as { trustedWorkspaces: string[] };
    expect(settings.trustedWorkspaces).toHaveLength(2);
    expect(settings.trustedWorkspaces).toEqual(expect.arrayContaining([firstRepo, secondRepo]));
    expect(fs.existsSync(path.join(home, '.gemini', 'antigravity-cli', '.doom-pi-sync.lock'))).toBe(false);
  });

  it('removes stale managed Antigravity skills and hooks', async () => {
    const repoRoot = path.join(temporaryDirectory, 'repo');
    const home = path.join(temporaryDirectory, 'home');
    const executablePath = createFakeAgy(temporaryDirectory);
    const pluginDirectory = path.join(repoRoot, 'plugins', 'sample');
    writeJson(path.join(pluginDirectory, '.codex-plugin', 'plugin.json'), { name: 'sample' });
    fs.mkdirSync(path.join(pluginDirectory, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.claude', 'skills', 'shared'), { recursive: true });
    writeJson(path.join(repoRoot, '.antigravity-local', 'hooks.json'), {
      hooks: [{ command: 'echo $AGY_REPO_ROOT' }],
    });
    const context = antigravityContext(repoRoot, home, executablePath, {
      plugins: [{ directory: pluginDirectory }],
      sharedSkills: true,
    });

    await expect(launchCompatibility(context)).resolves.toBe(0);
    const pluginSkills = path.join(repoRoot, '_agents', 'plugins', 'sample', 'skills');
    const corePlugin = path.join(repoRoot, '_agents', 'plugins', 'core');
    const generatedHooks = path.join(repoRoot, '.agents', 'hooks.json');
    expect(fs.lstatSync(pluginSkills).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(corePlugin)).toBe(true);
    expect(fs.existsSync(generatedHooks)).toBe(true);

    fs.rmSync(path.join(pluginDirectory, 'skills'), { recursive: true });
    fs.rmSync(path.join(repoRoot, '.claude', 'skills'), { recursive: true });
    fs.rmSync(path.join(repoRoot, '.antigravity-local', 'hooks.json'));
    await expect(launchCompatibility(context)).resolves.toBe(0);

    expect(fs.existsSync(pluginSkills)).toBe(false);
    expect(fs.existsSync(corePlugin)).toBe(false);
    expect(fs.existsSync(generatedHooks)).toBe(false);

    await expect(launchCompatibility({ ...context, plugins: [] })).resolves.toBe(0);
    expect(fs.existsSync(path.dirname(pluginSkills))).toBe(false);
  });

  it('rejects plugin names that escape the managed Antigravity directory', async () => {
    const repoRoot = path.join(temporaryDirectory, 'repo');
    const home = path.join(temporaryDirectory, 'home');
    const executablePath = createFakeAgy(temporaryDirectory);
    const pluginDirectory = path.join(repoRoot, 'plugins', 'unsafe');
    writeJson(path.join(pluginDirectory, '.codex-plugin', 'plugin.json'), { name: '../escape' });
    const context = antigravityContext(repoRoot, home, executablePath, {
      plugins: [{ directory: pluginDirectory }],
    });

    await expect(launchCompatibility(context)).rejects.toThrow('Invalid Antigravity plugin name');
    expect(fs.existsSync(path.join(repoRoot, '_agents', 'escape'))).toBe(false);
  });

  it.each(['core', 'Core', 'CORE'])('reserves the Antigravity core plugin name: %s', async (pluginName: string) => {
    const repoRoot = path.join(temporaryDirectory, 'repo');
    const home = path.join(temporaryDirectory, 'home');
    const executablePath = createFakeAgy(temporaryDirectory);
    const pluginDirectory = path.join(repoRoot, 'plugins', 'unsafe');
    writeJson(path.join(pluginDirectory, '.codex-plugin', 'plugin.json'), { name: pluginName });
    const context = antigravityContext(repoRoot, home, executablePath, {
      plugins: [{ directory: pluginDirectory }],
    });

    await expect(launchCompatibility(context)).rejects.toThrow('Invalid Antigravity plugin name');
  });

  it('refuses plugin target symlinks that escape the managed directory', async () => {
    const repoRoot = path.join(temporaryDirectory, 'repo');
    const home = path.join(temporaryDirectory, 'home');
    const executablePath = createFakeAgy(temporaryDirectory);
    const pluginDirectory = path.join(repoRoot, 'plugins', 'sample');
    const outsideDirectory = path.join(temporaryDirectory, 'outside');
    writeJson(path.join(pluginDirectory, '.codex-plugin', 'plugin.json'), { name: 'sample' });
    fs.mkdirSync(path.join(repoRoot, '_agents', 'plugins'), { recursive: true });
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.symlinkSync(outsideDirectory, path.join(repoRoot, '_agents', 'plugins', 'sample'), 'dir');
    const context = antigravityContext(repoRoot, home, executablePath, {
      plugins: [{ directory: pluginDirectory }],
    });

    await expect(launchCompatibility(context)).rejects.toThrow('Refusing to use unmanaged Antigravity path');
    expect(fs.existsSync(path.join(outsideDirectory, 'plugin.json'))).toBe(false);
  });

  it('preserves unmanaged Antigravity hooks and refuses to overwrite them', async () => {
    const repoRoot = path.join(temporaryDirectory, 'repo');
    const home = path.join(temporaryDirectory, 'home');
    const executablePath = createFakeAgy(temporaryDirectory);
    const hooksPath = path.join(repoRoot, '.agents', 'hooks.json');
    const customHooks = '{"custom":true}\n';
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, customHooks);
    const context = antigravityContext(repoRoot, home, executablePath);

    await expect(launchCompatibility(context)).resolves.toBe(0);
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(customHooks);

    writeJson(path.join(repoRoot, '.antigravity-local', 'hooks.json'), { hooks: [] });
    await expect(launchCompatibility(context)).rejects.toThrow('Refusing to replace unmanaged Antigravity path');
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(customHooks);
  });

  it('dispatches the claude provider to the claude binary in the invocation directory', async () => {
    const binDirectory = path.join(temporaryDirectory, 'bin');
    const captured = path.join(temporaryDirectory, 'claude-args');
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, 'claude'), `#!/bin/sh\necho "$@" > ${captured}\nexit 0\n`, {
      mode: 0o755,
    });
    const context = baseContext({
      options: baseOptions({ provider: 'claude', currentDirectory: temporaryDirectory, skipPermissions: true }),
      environment: { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    await expect(launchCompatibility(context)).resolves.toBe(0);

    const forwarded = fs.readFileSync(captured, 'utf8');
    expect(forwarded).toContain('--dangerously-skip-permissions');
    expect(forwarded).toContain('--strict-mcp-config');
    expect(forwarded.trim().endsWith('prompt')).toBe(true);
  });

  it('surfaces the claude exit code', async () => {
    const binDirectory = path.join(temporaryDirectory, 'bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, 'claude'), '#!/bin/sh\nexit 8\n', { mode: 0o755 });
    const context = baseContext({
      options: baseOptions({ provider: 'claude', currentDirectory: temporaryDirectory }),
      environment: { PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    await expect(launchCompatibility(context)).resolves.toBe(8);
  });

  it.each([
    { args: [], expected: true },
    { args: ['exec', 'prompt'], expected: true },
    { args: ['debug', 'prompt-input'], expected: true },
    { args: ['login'], expected: false },
    { args: ['plugin', 'list'], expected: false },
    { args: ['--model', 'gpt-5', 'prompt'], expected: true },
  ])('detects whether Codex arguments support the managed profile: $args', ({ args, expected }) => {
    expect(supportsCodexManagedProfile(args)).toBe(expected);
  });
});
