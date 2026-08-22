import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  DOOM_MCP_SESSION_ENV_VAR,
  DoomMcpSessionConfigSchema,
  doomMcpSessionEnvironment,
  parseDoomMcpSessionConfig,
  readDoomMcpSessionConfig,
  serializeDoomMcpSessionConfig,
  type DoomMcpSessionConfig,
} from '../src/exports/mcpSession.ts';

const config: DoomMcpSessionConfig = {
  enabled: true,
  repoRoot: '/workspace',
  stagingDirectory: '/tmp/doom-mcp',
  pluginConfigPaths: ['/plugins/example/.mcp.json'],
  allowlist: { servers: ['pencil'], proxy: ['log-sink'] },
};

describe('Doom MCP session wire', () => {
  it('round-trips a validated neutral session document', () => {
    const serialized = serializeDoomMcpSessionConfig(config);
    expect(parseDoomMcpSessionConfig(serialized)).toEqual(config);
    expect(doomMcpSessionEnvironment(config)).toEqual({ [DOOM_MCP_SESSION_ENV_VAR]: serialized });
    expect(readDoomMcpSessionConfig({ [DOOM_MCP_SESSION_ENV_VAR]: serialized })).toEqual(config);
    expect(Check(DoomMcpSessionConfigSchema, config)).toBe(true);
  });

  it('returns absence for missing or malformed wire input', () => {
    expect(readDoomMcpSessionConfig({})).toBeUndefined();
    expect(parseDoomMcpSessionConfig('{')).toBeUndefined();
    expect(parseDoomMcpSessionConfig(JSON.stringify({ repoRoot: '/workspace' }))).toBeUndefined();
  });

  it('rejects invalid configuration at serialization', () => {
    const invalid = { ...config, stagingDirectory: '' } as DoomMcpSessionConfig;
    expect(() => serializeDoomMcpSessionConfig(invalid)).toThrow('Invalid Doom MCP session config');
  });
});
