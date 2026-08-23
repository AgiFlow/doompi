import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHarnessArgs } from '../../src/exports/cli/options';

describe('parseHarnessArgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the default domain with no profile and forwards Pi arguments', () => {
    const result = parseHarnessArgs(['--model', 'openai-codex/gpt-5.6-terra', 'fix this'], {}, '/repo');

    expect(result.options.domains).toEqual(['default']);
    expect(result.options.profile).toBeUndefined();
    expect(result.options.piArgs).toEqual(['--model', 'openai-codex/gpt-5.6-terra', 'fix this']);
    expect(result.options.cwd).toBe('/repo');
    expect(result.options.outputFormat).toBe('native');
    expect(result.options.mute).toBe(false);
    expect(result.options.autoStop).toBe(false);
    expect(result.options.allowProtectedWrites).toBe(false);
    expect(result.options.majorMode).toBe('copilot');
  });

  it('uses the configured default major mode when no stronger selection exists', () => {
    const result = parseHarnessArgs([], {}, '/repo', 'marketing');

    expect(result.options.majorMode).toBe('marketing');
    expect(result.options.domains).toEqual(['marketing']);
  });

  it('uses multiple configured default domains after environment and flags', () => {
    const configured = parseHarnessArgs([], {}, '/repo', 'marketing', ['development', 'qa']);
    const none = parseHarnessArgs([], {}, '/repo', 'minimal', []);
    const inherited = parseHarnessArgs([], { DOOMPI_DOMAINS: 'marketing' }, '/repo', 'minimal', ['development', 'qa']);
    const explicit = parseHarnessArgs(
      ['--domains', 'product,pm'],
      { DOOMPI_DOMAINS: 'marketing' },
      '/repo',
      'minimal',
      ['development', 'qa'],
    );

    expect(configured.options.domains).toEqual(['development', 'qa']);
    expect(none.options.domains).toEqual([]);
    expect(inherited.options.domains).toEqual(['marketing']);
    expect(explicit.options.domains).toEqual(['product', 'pm']);
  });

  it('uses the dev base when its layer is selected', () => {
    const result = parseHarnessArgs(['--major-mode', 'dev', 'implement the task'], {}, '/repo', 'minimal');

    expect(result.options.domains).toEqual(['default']);
    expect(result.options.majorMode).toBe('dev');
    expect(result.options.piArgs).toEqual(['implement the task']);
  });

  it('uses the marketing domain when the marketing major mode is selected inline', () => {
    const result = parseHarnessArgs(['--major-mode=marketing', 'write campaign copy'], {}, '/repo');

    expect(result.options.domains).toEqual(['marketing']);
    expect(result.options.profile).toBeUndefined();
    expect(result.options.majorMode).toBe('marketing');
    expect(result.options.piArgs).toEqual(['write campaign copy']);
  });

  it('inherits the major mode for spawned harness sessions', () => {
    const result = parseHarnessArgs(['write campaign copy'], { DOOMPI_MAJOR_MODE: 'marketing' }, '/repo');

    expect(result.options.domains).toEqual(['marketing']);
    expect(result.options.majorMode).toBe('marketing');
  });

  it('lets the CLI override the inherited major mode', () => {
    const result = parseHarnessArgs(['--major-mode', 'dev'], { DOOMPI_MAJOR_MODE: 'marketing' }, '/repo');

    expect(result.options.majorMode).toBe('dev');
    expect(result.options.domains).toEqual(['default']);
  });

  it('rejects a leftover variable from the retired AGENT_HARNESS namespace', () => {
    expect(() => parseHarnessArgs([], { AGENT_HARNESS_MAJOR_MODE: 'dev' }, '/repo')).toThrow(
      'AGENT_HARNESS_MAJOR_MODE -> DOOMPI_MAJOR_MODE',
    );
  });

  it('rejects a retired variable even when the flag would have won anyway', () => {
    expect(() => parseHarnessArgs(['--major-mode', 'dev'], { AGENT_HARNESS_TEMP_DIR: '/tmp/x' }, '/repo')).toThrow(
      'AGENT_HARNESS_TEMP_DIR -> DOOMPI_TEMP_DIR',
    );
  });

  it('reads profile, domains, and major mode defaults from Doompi environment variables', () => {
    const result = parseHarnessArgs(
      [],
      {
        DOOMPI_PROFILE: 'marketing-agiflow',
        DOOMPI_DOMAINS: 'development,qa',
        DOOMPI_MAJOR_MODE: 'dev',
      },
      '/repo',
    );

    expect(result.options.profile).toBe('marketing-agiflow');
    expect(result.options.domains).toEqual(['development', 'qa']);
    expect(result.options.majorMode).toBe('dev');
  });

  it('lets an explicit profile override DOOMPI_PROFILE', () => {
    const result = parseHarnessArgs(['--profile', 'product-agiflow'], { DOOMPI_PROFILE: 'marketing-agiflow' }, '/repo');
    expect(result.options.profile).toBe('product-agiflow');
  });

  it('adds deterministic automation flags without duplicating explicit flags', () => {
    const result = parseHarnessArgs(['--automation', '-p', '--mode', 'json', 'run'], {}, '/repo');

    expect(result.options.piArgs).toEqual(['--approve', '-p', '--mode', 'json', 'run']);
  });

  it('selects vibe-lint output and permits an explicitly empty domain set', () => {
    const result = parseHarnessArgs(
      ['--no-domains', '--major-mode', 'dev', '--mute', '--output-format=vibe-lint'],
      {},
      '/repo',
    );

    expect(result.options.domains).toEqual([]);
    expect(result.options.majorMode).toBe('dev');
    expect(result.options.outputFormat).toBe('vibe-lint');
    expect(result.options.mute).toBe(true);
    expect(result.options.piArgs).toEqual([]);
  });

  it('enables native auto-stop for interactive mode', () => {
    const result = parseHarnessArgs(['--auto-stop', 'run'], {}, '/repo');

    expect(result.options.autoStop).toBe(true);
    expect(result.options.piArgs).toEqual(['run']);
  });

  it('enables protected writes without forwarding the harness flag to Pi', () => {
    const result = parseHarnessArgs(['--allow-protected-writes', 'run'], {}, '/repo');

    expect(result.options.allowProtectedWrites).toBe(true);
    expect(result.options.piArgs).toEqual(['run']);
  });

  it('enables the sandbox without forwarding the harness flag to Pi', () => {
    const result = parseHarnessArgs(['--sandbox', 'run'], {}, '/repo');

    expect(result.options.sandbox).toBe(true);
    expect(result.options.piArgs).toEqual(['run']);
  });

  it('consumes and deduplicates additional directories without forwarding them to Pi', () => {
    const result = parseHarnessArgs(
      ['--add-dir', './workflow-run', '--add-dir', '/shared', '--add-dir', './workflow-run', 'run'],
      { DOOMPI_ADDITIONAL_DIRS: '/inherited' },
      '/repo',
    );

    expect(result.options.additionalDirectories).toEqual(['/inherited', '/repo/workflow-run', '/shared']);
    expect(result.options.piArgs).toEqual(['run']);
  });

  it('rejects auto-stop outside interactive mode', () => {
    expect(() => parseHarnessArgs(['--auto-stop', '--automation', 'run'], {}, '/repo')).toThrow(
      '--auto-stop only supports interactive Pi mode',
    );
    expect(() => parseHarnessArgs(['--auto-stop', '--print', 'run'], {}, '/repo')).toThrow(
      '--auto-stop only supports interactive Pi mode',
    );
    expect(() => parseHarnessArgs(['--auto-stop', '--output-format', 'vibe-lint'], {}, '/repo')).toThrow(
      '--auto-stop only supports interactive Pi mode',
    );
  });

  it('translates Claude compatibility flags', () => {
    const result = parseHarnessArgs(
      ['--effort', 'high', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      {},
      '/repo',
    );

    expect(result.options.piArgs).toEqual(['--thinking', 'high', '--mode', 'json']);
  });

  it('normalizes Kimi aliases and legacy credentials', () => {
    const result = parseHarnessArgs(
      ['--preset', 'kimi', '--model', 'kimi-k2.7-code'],
      { KIMI_CODE_MODEL: 'kimi-k2.6' },
      '/repo',
    );

    expect(result.options.piArgs).toEqual(['--model', 'kimi-coding/kimi-for-coding']);
  });

  it('normalizes unqualified Ollama models to cloud models', () => {
    const result = parseHarnessArgs(['--preset=ollama', '--model=qwen3'], {}, '/repo');

    expect(result.options.piArgs).toEqual(['--model=ollama/qwen3:cloud']);
  });

  it('parses harness toggles, paths, inline compatibility flags, a profile, and domains', () => {
    const result = parseHarnessArgs(
      [
        '--profile',
        'marketing-agiflow',
        '--domains',
        'qa,development',
        '--plugin-dir',
        './plugin',
        '--cwd',
        './worktree',
        '--no-hooks',
        '--no-mcp',
        '--no-agents',
        '--effort=low',
        '--output-format=json',
        '--model=openai-codex/gpt-5.6-terra',
      ],
      {},
      '/repo',
    );

    expect(result.options).toMatchObject({
      cwd: '/repo/worktree',
      profile: 'marketing-agiflow',
      domains: ['qa', 'development'],
      pluginDirectories: ['/repo/plugin'],
      hooks: false,
      mcp: false,
      agents: false,
      piArgs: ['--thinking=low', '--mode=json', '--model=openai-codex/gpt-5.6-terra'],
    });
  });

  it('reports help and version without resolving the matrix', () => {
    const result = parseHarnessArgs(
      ['--hooks', '--mcp', '--agents', '--help', '--version'],
      { DOOMPI_PRESET: 'default', DOOMPI_DOMAINS: 'qa,development' },
      '/repo',
    );

    expect(result.help).toBe(true);
    expect(result.version).toBe(true);
  });

  it('answers help even when a retired variable would otherwise throw', () => {
    const result = parseHarnessArgs(['--help'], { AGENT_HARNESS_MAJOR_MODE: 'dev' }, '/repo');

    expect(result.help).toBe(true);
  });

  it('supports explicit enable flags', () => {
    const result = parseHarnessArgs(['--hooks', '--mcp', '--agents'], {}, '/repo');

    expect(result.options.hooks).toBe(true);
    expect(result.options.mcp).toBe(true);
    expect(result.options.agents).toBe(true);
  });

  it('accepts inline matrix options that were previously forwarded to Pi unrecognised', () => {
    const result = parseHarnessArgs(
      ['--profile=product-agiflow', '--domains=qa,development', '--domain=pm', 'run'],
      {},
      '/repo',
    );

    expect(result.options.profile).toBe('product-agiflow');
    expect(result.options.domains).toEqual(['qa', 'development', 'pm']);
    expect(result.options.piArgs).toEqual(['run']);
  });

  it('accepts inline directory, preset, and emit-mcp options', () => {
    const result = parseHarnessArgs(
      ['--plugin-dir=./plugin', '--add-dir=./shared', '--cwd=./worktree', '--emit-mcp=./out', '--preset=kimi'],
      {},
      '/repo',
    );

    expect(result.options.pluginDirectories).toEqual(['/repo/plugin']);
    expect(result.options.additionalDirectories).toEqual(['/repo/shared']);
    expect(result.options.cwd).toBe('/repo/worktree');
    expect(result.options.emitMcp).toBe('/repo/out');
    expect(result.options.preset).toBe('kimi');
    // No model was supplied, so the preset prepends one.
    expect(result.options.piArgs).toEqual(['--model', 'kimi-coding/kimi-for-coding']);
  });

  it('resolves directory options against the invocation directory whatever the flag order', () => {
    const pluginFirst = parseHarnessArgs(['--plugin-dir', './plugin', '--cwd', './worktree'], {}, '/repo');
    const cwdFirst = parseHarnessArgs(['--cwd', './worktree', '--plugin-dir', './plugin'], {}, '/repo');

    expect(pluginFirst.options.pluginDirectories).toEqual(['/repo/plugin']);
    expect(cwdFirst.options.pluginDirectories).toEqual(pluginFirst.options.pluginDirectories);
    expect(cwdFirst.options.cwd).toBe('/repo/worktree');
    expect(pluginFirst.options.cwd).toBe(cwdFirst.options.cwd);
  });

  it('refuses an option value that is another flag or only whitespace', () => {
    expect(() => parseHarnessArgs(['--profile', '--explain'], {}, '/repo')).toThrow('--profile requires a value');
    expect(() => parseHarnessArgs(['--major-mode', '--explain'], {}, '/repo')).toThrow('--major-mode requires a value');
    expect(() => parseHarnessArgs(['--profile', ' '], {}, '/repo')).toThrow('--profile requires a value');
    expect(() => parseHarnessArgs(['--major-mode', ' '], {}, '/repo')).toThrow('--major-mode requires a value');
    expect(() => parseHarnessArgs(['--profile='], {}, '/repo')).toThrow('--profile requires a value');
    expect(() => parseHarnessArgs(['--domains='], {}, '/repo')).toThrow('--domains requires a value');
    expect(() => parseHarnessArgs(['--profiles=qa'], {}, '/repo')).toThrow('--profiles was replaced by --domains');
  });

  it('rejects invalid singular major mode input, removed flags, and unsupported presets', () => {
    expect(() => parseHarnessArgs(['--profile'], {}, '/repo')).toThrow('--profile requires a value');
    expect(() => parseHarnessArgs(['--profiles', 'qa'], {}, '/repo')).toThrow('--profiles was replaced by --domains');
    expect(() => parseHarnessArgs(['--profile', 'one,two'], {}, '/repo')).toThrow('accepts one profile name');
    expect(() => parseHarnessArgs([], { DOOMPI_PROFILE: 'one,two' }, '/repo')).toThrow(
      'DOOMPI_PROFILE accepts one profile name',
    );
    expect(() => parseHarnessArgs(['--profile', 'one', '--profile', 'two'], {}, '/repo')).toThrow(
      'can only be provided once',
    );
    expect(() => parseHarnessArgs(['--add-dir'], {}, '/repo')).toThrow('--add-dir requires a value');
    expect(() => parseHarnessArgs(['--major-mode'], {}, '/repo')).toThrow('--major-mode requires a value');
    expect(() => parseHarnessArgs(['--major-mode='], {}, '/repo')).toThrow('--major-mode requires a value');
    expect(() => parseHarnessArgs(['--major-mode', 'dev', '--major-mode', 'marketing'], {}, '/repo')).toThrow(
      '--major-mode can only be provided once',
    );
    expect(() => parseHarnessArgs(['--major-mode=dev,marketing'], {}, '/repo')).toThrow(
      '--major-mode accepts one major mode name',
    );
    expect(() => parseHarnessArgs(['--target=dev'], {}, '/repo')).toThrow('--target was replaced by --major-mode');
    expect(() => parseHarnessArgs(['--layers', '-goal'], {}, '/repo')).toThrow('--layers was removed');
    expect(() => parseHarnessArgs(['--preset=unknown'], {}, '/repo')).toThrow('Unsupported preset: unknown');
    expect(() => parseHarnessArgs(['--domains', 'qa', '--no-domains'], {}, '/repo')).toThrow(
      '--no-domains cannot be combined with --domains',
    );
  });
});
