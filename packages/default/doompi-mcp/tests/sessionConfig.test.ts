import { describe, expect, it } from 'vitest';
import { readSessionConfig, sessionConfigEnvironment } from '../src/adapters/process/sessionConfig.ts';
import { SESSION_ENV_VAR } from '../src/schemas/sessionConfig.ts';

function envWith(value: unknown): NodeJS.ProcessEnv {
  return { [SESSION_ENV_VAR]: typeof value === 'string' ? value : JSON.stringify(value) };
}

describe('readSessionConfig', () => {
  it('reads the configuration doom-pi resolved for this session', () => {
    const config = readSessionConfig(
      envWith({
        repoRoot: '/repo',
        generatedConfigPath: '/run/staging/mcp.json',
        pluginConfigPaths: ['/repo/plugins/design/.mcp.json'],
        allowlist: { servers: ['pencil'], proxy: ['log-sink'] },
        stagingDirectory: '/run/staging',
      }),
    );

    expect(config).toEqual({
      repoRoot: '/repo',
      generatedConfigPath: '/run/staging/mcp.json',
      pluginConfigPaths: ['/repo/plugins/design/.mcp.json'],
      allowlist: { servers: ['pencil'], proxy: ['log-sink'] },
      stagingDirectory: '/run/staging',
    });
  });

  // A bare Pi session outside doom-pi still gets the repository's own servers.
  it('falls back to the working directory when nothing was supplied', () => {
    const config = readSessionConfig({});

    expect(config.repoRoot).toBe(process.cwd());
    expect(config.pluginConfigPaths).toBeUndefined();
    expect(config.allowlist).toBeUndefined();
    expect(config.stagingDirectory).toContain('doom-mcp');
  });

  // Losing MCP is recoverable; losing the session is not.
  it('falls back rather than throwing on a malformed value', () => {
    expect(readSessionConfig(envWith('{ not json')).repoRoot).toBe(process.cwd());
  });

  it('falls back when the value is not an object', () => {
    expect(readSessionConfig(envWith('"a string"')).repoRoot).toBe(process.cwd());
    expect(readSessionConfig(envWith('null')).repoRoot).toBe(process.cwd());
  });

  it('ignores fields of the wrong type', () => {
    const config = readSessionConfig(envWith({ repoRoot: 42, pluginConfigPaths: 'not-a-list', stagingDirectory: '' }));

    expect(config.repoRoot).toBe(process.cwd());
    expect(config.pluginConfigPaths).toBeUndefined();
    expect(config.stagingDirectory).toContain('doom-mcp');
  });

  it('drops non-string entries from the plugin list', () => {
    const config = readSessionConfig(envWith({ repoRoot: '/repo', pluginConfigPaths: ['/a/.mcp.json', 7, ''] }));

    expect(config.pluginConfigPaths).toEqual(['/a/.mcp.json']);
  });

  describe('allowlist', () => {
    it('keeps a server list on its own', () => {
      const config = readSessionConfig(envWith({ repoRoot: '/repo', allowlist: { servers: ['pencil'] } }));

      expect(config.allowlist).toEqual({ servers: ['pencil'] });
    });

    it('keeps a proxy list on its own', () => {
      const config = readSessionConfig(envWith({ repoRoot: '/repo', allowlist: { proxy: ['log-sink'] } }));

      expect(config.allowlist).toEqual({ proxy: ['log-sink'] });
    });

    // An empty allowlist means the same as none: keep everything.
    it('reports no allowlist when both lists are empty', () => {
      const config = readSessionConfig(envWith({ repoRoot: '/repo', allowlist: { servers: [], proxy: [] } }));

      expect(config.allowlist).toBeUndefined();
    });

    it('reports no allowlist when the field is not an object', () => {
      expect(readSessionConfig(envWith({ repoRoot: '/repo', allowlist: 'all' })).allowlist).toBeUndefined();
      expect(readSessionConfig(envWith({ repoRoot: '/repo', allowlist: null })).allowlist).toBeUndefined();
    });
  });
});

describe('sessionConfigEnvironment', () => {
  it('round-trips through the environment doom-pi hands the child process', () => {
    const config = { repoRoot: '/repo', stagingDirectory: '/run/staging', allowlist: { servers: ['pencil'] } };

    expect(readSessionConfig(sessionConfigEnvironment(config))).toEqual(config);
  });
});
