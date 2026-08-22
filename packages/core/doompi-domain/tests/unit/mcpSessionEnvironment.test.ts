import { DOOM_MCP_SESSION_ENV_VAR } from '@agimon-ai/doompi-extension-contracts/mcp-session';
import { describe, expect, it } from 'vitest';
import { mcpSessionEnvironment } from '../../src/adapters/mcpSessionEnvironment.ts';

describe('mcpSessionEnvironment', () => {
  it('projects the complete picture the session needs', () => {
    const environment = mcpSessionEnvironment({
      repoRoot: '/repo',
      stagingDirectory: '/run/session',
      generatedConfigPath: '/run/session/mcp.json',
      pluginConfigPaths: ['/repo/plugins/design/.mcp.json'],
      allowlist: { servers: ['figma'] },
    });

    expect(JSON.parse(environment[DOOM_MCP_SESSION_ENV_VAR] ?? '{}')).toEqual({
      repoRoot: '/repo',
      stagingDirectory: '/run/session',
      generatedConfigPath: '/run/session/mcp.json',
      pluginConfigPaths: ['/repo/plugins/design/.mcp.json'],
      allowlist: { servers: ['figma'] },
    });
  });

  it('omits every optional key rather than projecting an empty one', () => {
    const environment = mcpSessionEnvironment({
      repoRoot: '/repo',
      stagingDirectory: '/run/session',
      pluginConfigPaths: [],
    });

    expect(JSON.parse(environment[DOOM_MCP_SESSION_ENV_VAR] ?? '{}')).toEqual({
      repoRoot: '/repo',
      stagingDirectory: '/run/session',
    });
  });

  it('copies the allowlist so a later mutation cannot reach the projection', () => {
    const allowlist = { servers: ['figma'] };
    const environment = mcpSessionEnvironment({
      repoRoot: '/repo',
      stagingDirectory: '/run/session',
      allowlist,
    });
    allowlist.servers.push('leaked');

    expect(environment[DOOM_MCP_SESSION_ENV_VAR]).not.toContain('leaked');
  });
});
