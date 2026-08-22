import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../src/commands/baseCommand';
import { EmitMcpCommand } from '../../src/commands/emitMcpCommand';
import { ExplainCommand, explainMatrix } from '../../src/commands/explainCommand';
import type { MatrixExplanation } from '../../src/commands/explainCommand';
import type { HarnessOptions } from '../../src/types/interfaces/harness';
import type { HarnessContext } from '../../src/adapters/harnessContext';

function baseExplanation(overrides: Partial<MatrixExplanation> = {}): MatrixExplanation {
  return {
    majorMode: 'copilot',
    domains: ['default'],
    plugins: ['/repo/plugins/shared'],
    layers: ['guardrails'],
    hookGroups: ['guardrails'],
    hooksEnabled: true,
    skillDirectories: ['/repo/.claude/skills'],
    skillCount: 12,
    agentCount: 3,
    agentDirectories: ['/tmp/run/agents'],
    mcpServers: ['project-mcp'],
    mcpFiltered: false,
    ...overrides,
  };
}

function harnessOptions(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    repoRoot: '/repo',
    cwd: '/repo',
    domains: ['default'],
    majorMode: 'copilot',
    explain: false,
    pluginDirectories: [],
    additionalDirectories: [],
    preset: 'default',
    outputFormat: 'native',
    mute: false,
    automation: false,
    autoStop: false,
    allowProtectedWrites: false,
    hooks: true,
    mcp: true,
    agents: true,
    piArgs: [],
    ...overrides,
  };
}

function harnessContext(root: string, overrides: Partial<HarnessContext> = {}): HarnessContext {
  return {
    options: harnessOptions(),
    environment: {},
    plugins: [{ directory: path.join(root, 'plugins', 'shared') }],
    majorModesConfig: { layers: {}, defaultMajorMode: 'copilot', majorMode: {} },
    selectedLayers: ['guardrails'],
    hookGroups: ['guardrails'],
    defaultThemePath: path.join(root, 'theme.json'),
    resources: {
      temporaryDirectory: root,
      skillDirectories: [path.join(root, '.claude', 'skills')],
      skillCount: 4,
      agentCount: 1,
      agentDirectories: [path.join(root, 'agents')],
      pluginHooks: [],
      cleanup: async () => undefined,
    },
    cleanup: async () => undefined,
    ...overrides,
  } as HarnessContext;
}

describe('explainMatrix', () => {
  it('reports every axis of a fully populated matrix', () => {
    const output = explainMatrix(
      baseExplanation({
        profile: 'product-agiflow',
        persona: 'agents/agiflow/vuong-ngo',
        mcpProxyUpstreams: ['log-sink'],
        mcpFiltered: true,
      }),
    );

    expect(output).toContain('major mode: copilot');
    expect(output).toContain('product-agiflow');
    expect(output).toContain('agents/agiflow/vuong-ngo');
    expect(output).toContain('mcp servers (filtered by domain allowlist)');
    expect(output).toContain('mcp proxy upstreams (filtered)');
    expect(output).toContain('log-sink');
    expect(output).toContain('skills: 12 (from 1 paths)');
    expect(output).toContain('agents: 3');
  });

  it('prices the selection and names what the figure leaves out', () => {
    const output = explainMatrix(
      baseExplanation({ cost: { skillPromptTokens: 3_772, skillBodyTokens: 54_145, personaTokens: 228 } }),
    );

    expect(output).toContain('context cost (tokens)');
    expect(output).toContain('skills prompt');
    expect(output).toContain('3,772');
    // Startup is the always-on pair, not the bodies, which are read on demand.
    expect(output).toContain('startup total');
    expect(output).toContain('4,000');
    expect(output).toContain('54,145');
    expect(output).toContain('Excludes MCP tool schemas');
  });

  it('omits the cost section when nothing priced the selection', () => {
    expect(explainMatrix(baseExplanation())).not.toContain('context cost');
  });

  it('marks an absent profile and persona rather than omitting the sections', () => {
    const output = explainMatrix(baseExplanation());

    expect(output).toContain('profile:\n  (none)');
    expect(output).toContain('persona:\n  (none)');
  });

  it('says the MCP surface is unfiltered when no domain narrowed it', () => {
    const output = explainMatrix(baseExplanation());

    expect(output).toContain('mcp servers (unfiltered)');
    expect(output).toContain('mcp proxy upstreams:\n  (unfiltered, every upstream in mcp-config.yaml)');
  });

  it('distinguishes a core-only layer set from hooks being disabled', () => {
    expect(explainMatrix(baseExplanation({ layers: [], hookGroups: [] }))).toContain('core only');
    expect(explainMatrix(baseExplanation({ hookGroups: [] }))).toContain('(core groups only)');
    expect(explainMatrix(baseExplanation({ hookGroups: [], hooksEnabled: false }))).toContain('(hooks disabled)');
  });

  it('reports a disabled MCP configuration', () => {
    const output = explainMatrix(baseExplanation({ mcpServers: [], mcpConfigPath: undefined }));

    expect(output).toContain('(mcp disabled)');
    expect(output).toContain('mcp config: (disabled)');
  });

  it('shortens plugin paths to their directory name', () => {
    const output = explainMatrix(baseExplanation({ plugins: ['/repo/plugins/product-marketing'] }));

    expect(output).toContain('  product-marketing');
    expect(output).not.toContain('/repo/plugins/product-marketing');
  });
});

describe('command selection and execution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-commands-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('claims the run only when --explain was given', () => {
    const command = new ExplainCommand();

    expect(command.name).toBe('explain');
    expect(command.matches(harnessOptions({ explain: true }))).toBe(true);
    expect(command.matches(harnessOptions())).toBe(false);
  });

  it('prints the resolved matrix read back from the generated config', async () => {
    const mcpConfigPath = path.join(root, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { 'project-mcp': {} } }));
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const context = harnessContext(root, {
      profile: 'product',
      personaDirectory: 'agents/acme/pat',
      mcpAllowlist: { servers: ['project-mcp'], proxy: ['log-sink'] },
    });
    context.resources.mcpConfigPath = mcpConfigPath;

    await expect(new ExplainCommand().execute(context)).resolves.toBe(0);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain('project-mcp');
    expect(output).toContain('mcp servers (filtered by domain allowlist)');
  });

  it('reports no servers when MCP is disabled for the run', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await expect(new ExplainCommand().execute(harnessContext(root))).resolves.toBe(0);

    expect(String(write.mock.calls[0]?.[0])).toContain('(mcp disabled)');
  });

  it('claims the run only when --emit-mcp was given', () => {
    const command = new EmitMcpCommand();

    expect(command.name).toBe('emit-mcp');
    expect(command.matches(harnessOptions({ emitMcp: '/out' }))).toBe(true);
    expect(command.matches(harnessOptions())).toBe(false);
  });

  it('copies the generated config into the requested directory', async () => {
    const mcpConfigPath = path.join(root, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { 'project-mcp': { command: 'x' } } }));
    const target = path.join(root, 'emitted');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const context = harnessContext(root, { options: harnessOptions({ emitMcp: target }) });
    context.resources.mcpConfigPath = mcpConfigPath;

    await expect(new EmitMcpCommand().execute(context)).resolves.toBe(0);

    const emitted = path.join(target, 'mcp.json');
    expect(fs.existsSync(emitted)).toBe(true);
    expect(String(write.mock.calls[0]?.[0]).trim()).toBe(emitted);
  });

  it('refuses to emit without a target directory or without MCP enabled', async () => {
    await expect(new EmitMcpCommand().execute(harnessContext(root))).rejects.toThrow(
      '--emit-mcp requires a target directory',
    );
    await expect(
      new EmitMcpCommand().execute(harnessContext(root, { options: harnessOptions({ emitMcp: '/out' }) })),
    ).rejects.toThrow('--emit-mcp requires MCP to be enabled');
  });

  it('reports the failing command name and exits non-zero', async () => {
    class FailingCommand extends BaseCommand {
      readonly name = 'failing';
      matches(): boolean {
        return true;
      }
      async execute(): Promise<number> {
        return this.handleError(new Error('something broke'));
      }
    }
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });

    await expect(new FailingCommand().execute()).rejects.toThrow('exited');
    expect(write).toHaveBeenCalledWith('[doompi] failing: something broke\n');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stringifies a thrown value that is not an Error', async () => {
    class ThrowingCommand extends BaseCommand {
      readonly name = 'throwing';
      matches(): boolean {
        return true;
      }
      async execute(): Promise<number> {
        return this.handleError('plain string failure');
      }
    }
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });

    await expect(new ThrowingCommand().execute()).rejects.toThrow('exited');
    expect(write).toHaveBeenCalledWith('[doompi] throwing: plain string failure\n');
  });
});
