import { describe, expect, it } from 'vitest';
import { CliApp } from '../../src/exports/cli/cliApp';
import { EmitMcpCommand } from '../../src/commands/emitMcpCommand';
import { ExplainCommand, explainMatrix } from '../../src/commands/explainCommand';
import { LaunchCommand } from '../../src/commands/launchCommand';
import type { HarnessOptions } from '../../src/types/interfaces/harness';

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    repoRoot: '/repo',
    cwd: '/repo',
    domains: [],
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

describe('CliApp command dispatch', () => {
  const app = new CliApp();

  it('launches when no diagnostic flag is set', async () => {
    await expect(app.selectCommand(options())).resolves.toBeInstanceOf(LaunchCommand);
  });

  it('explains when --explain is set', async () => {
    await expect(app.selectCommand(options({ explain: true }))).resolves.toBeInstanceOf(ExplainCommand);
  });

  it('emits mcp when --emit-mcp is set', async () => {
    await expect(app.selectCommand(options({ emitMcp: '/tmp/out' }))).resolves.toBeInstanceOf(EmitMcpCommand);
  });

  // LaunchCommand matches everything, so registration order is what keeps the
  // diagnostic commands reachable at all.
  it('prefers the diagnostic command when both would match', async () => {
    await expect(app.selectCommand(options({ explain: true, emitMcp: '/tmp/out' }))).resolves.toBeInstanceOf(
      EmitMcpCommand,
    );
  });
});

describe('matrix explanation', () => {
  it('reports the selected major mode without target or delta terminology', () => {
    const output = explainMatrix({
      majorMode: 'dev',
      domains: ['default'],
      plugins: [],
      layers: ['guardrails', 'plan-mode'],
      hookGroups: ['guardrails'],
      hooksEnabled: true,
      skillDirectories: [],
      skillCount: 0,
      agentCount: 0,
      agentDirectories: [],
      mcpServers: [],
      mcpFiltered: false,
    });

    expect(output).toContain('major mode: dev');
    expect(output).not.toContain('target:');
    expect(output).not.toContain('deltas applied');
  });
});
