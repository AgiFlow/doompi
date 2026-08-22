import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_PLUGIN_MCP_SCHEMA_URL,
  type DoomMcpAgentPluginProjectionSource,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAgentPluginMcpSource } from '../src/adapters/agentPluginMcp.ts';

let temporaryDirectory: string;
let pluginRoot: string;
let pluginDataDirectory: string;
let stagingDirectory: string;

function writeConfig(config: unknown): DoomMcpAgentPluginProjectionSource {
  const configPath = path.join(pluginRoot, 'mcp.json');
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(configPath, contents);
  return {
    sourceId: 'plugin:design:mcp',
    owner: 'plugin',
    format: 'agent-plugin-v1',
    pluginId: 'design',
    pluginRoot,
    pluginDataDirectory,
    configPath,
    contentDigest: createHash('sha256').update(contents).digest('hex'),
    mcpSchemaUrl: AGENT_PLUGIN_MCP_SCHEMA_URL,
  };
}

function normalize(source: DoomMcpAgentPluginProjectionSource, allowedServers?: readonly string[]) {
  return normalizeAgentPluginMcpSource(source, { stagingDirectory, allowedServers });
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-agent-plugin-mcp-'));
  pluginRoot = path.join(temporaryDirectory, 'plugin');
  pluginDataDirectory = path.join(temporaryDirectory, 'data');
  stagingDirectory = path.join(temporaryDirectory, 'staging');
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDataDirectory, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'bin', 'server'), '#!/bin/sh\n');
  fs.chmodSync(path.join(pluginRoot, 'bin', 'server'), 0o755);
});

afterEach(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('normalizeAgentPluginMcpSource', () => {
  it('expands only portable placeholders and stages an owner-only internal layer', () => {
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: {
        design: {
          type: 'stdio',
          command: './bin/server',
          args: ['--plugin=${PLUGIN_ROOT}', '${HOME}/literal'],
          env: { CACHE: '${PLUGIN_DATA}/cache', UNTOUCHED: '${HOME}' },
          cwd: '${PLUGIN_DATA}/workspace',
        },
      },
    });

    const result = normalize(source);

    expect(result.diagnostics).toEqual([]);
    expect(result.configSource).toEqual({
      path: expect.stringMatching(/agent-plugin-mcp-[a-f0-9]+\.internal\.json$/u),
      format: 'internal',
      cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const staged = JSON.parse(fs.readFileSync(result.configSource!.path, 'utf8'));
    expect(staged.mcpServers.design).toEqual({
      name: 'design',
      transport: 'stdio',
      config: {
        command: fs.realpathSync(path.join(pluginRoot, 'bin', 'server')),
        args: [`--plugin=${fs.realpathSync(pluginRoot)}`, '${HOME}/literal'],
        env: {
          CACHE: `${fs.realpathSync(pluginDataDirectory)}/cache`,
          UNTOUCHED: '${HOME}',
          PLUGIN_ROOT: fs.realpathSync(pluginRoot),
          PLUGIN_DATA: fs.realpathSync(pluginDataDirectory),
        },
        cwd: fs.realpathSync(path.join(pluginDataDirectory, 'workspace')),
      },
    });
    expect(fs.statSync(result.configSource!.path).mode & 0o777).toBe(0o600);
    expect(result.claudeConfig.mcpServers.design).toEqual(
      expect.objectContaining({ type: 'stdio', cwd: fs.realpathSync(path.join(pluginDataDirectory, 'workspace')) }),
    );

    fs.chmodSync(result.configSource!.path, 0o644);
    fs.chmodSync(stagingDirectory, 0o755);
    const repeated = normalize(source);
    expect(repeated.configSource?.path).toBe(result.configSource!.path);
    expect(fs.statSync(result.configSource!.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(stagingDirectory).mode & 0o777).toBe(0o700);
  });

  it('keeps definitions-cache identity stable across private staging directories', () => {
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: { portable: { type: 'stdio', command: 'node' } },
    });
    const first = normalizeAgentPluginMcpSource(source, {
      stagingDirectory: path.join(temporaryDirectory, 'run-a'),
    });
    const second = normalizeAgentPluginMcpSource(source, {
      stagingDirectory: path.join(temporaryDirectory, 'run-b'),
    });

    expect(first.configSource?.path).not.toBe(second.configSource?.path);
    expect(first.configSource?.cacheKey).toBe(second.configSource?.cacheKey);
  });

  it('invalidates definitions-cache identity when the plugin root or data directory changes', () => {
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: { portable: { type: 'stdio', command: 'node' } },
    });
    const original = normalizeAgentPluginMcpSource(source, {
      stagingDirectory: path.join(temporaryDirectory, 'run-original'),
    });

    const relocatedDataDirectory = path.join(temporaryDirectory, 'relocated-data');
    fs.mkdirSync(relocatedDataDirectory);
    const relocatedData = normalizeAgentPluginMcpSource(
      { ...source, pluginDataDirectory: relocatedDataDirectory },
      { stagingDirectory: path.join(temporaryDirectory, 'run-data') },
    );

    const relocatedPluginRoot = path.join(temporaryDirectory, 'relocated-plugin');
    fs.mkdirSync(relocatedPluginRoot);
    const relocatedConfigPath = path.join(relocatedPluginRoot, 'mcp.json');
    fs.copyFileSync(source.configPath, relocatedConfigPath);
    const relocatedPlugin = normalizeAgentPluginMcpSource(
      { ...source, pluginRoot: relocatedPluginRoot, configPath: relocatedConfigPath },
      { stagingDirectory: path.join(temporaryDirectory, 'run-plugin') },
    );

    expect(relocatedData.configSource?.cacheKey).not.toBe(original.configSource?.cacheKey);
    expect(relocatedPlugin.configSource?.cacheKey).not.toBe(original.configSource?.cacheKey);
  });

  it('isolates invalid server entries while keeping valid transports', () => {
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: {
        valid: { type: 'streamable-http', url: 'https://mcp.example.test/v1', headers: { Authorization: 'ok' } },
        insecure: { type: 'streamable-http', url: 'http://mcp.example.test/v1' },
        reserved: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'forged' } },
      },
    });

    const result = normalize(source);

    expect(result.serverNames).toEqual(['valid']);
    expect(result.droppedServers).toEqual(['insecure', 'reserved']);
    expect(result.diagnostics).toEqual([
      expect.stringContaining('non-loopback MCP URLs must use https'),
      expect.stringContaining('env key "PLUGIN_ROOT" is reserved'),
    ]);
    expect(result.claudeConfig.mcpServers.valid).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/v1',
      headers: { Authorization: 'ok' },
    });
  });

  it('rejects a projected source whose bytes changed', () => {
    const source = writeConfig({ $schema: AGENT_PLUGIN_MCP_SCHEMA_URL, mcpServers: {} });
    fs.appendFileSync(source.configPath, ' ');

    const result = normalize(source);

    expect(result.configSource).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.stringContaining('content digest does not match')]);
  });

  it('contains relative commands after resolving symlinks', () => {
    const outside = path.join(temporaryDirectory, 'outside-command');
    fs.writeFileSync(outside, '#!/bin/sh\n');
    fs.symlinkSync(outside, path.join(pluginRoot, 'bin', 'escape'));
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: { escape: { type: 'stdio', command: './bin/escape' } },
    });

    const result = normalize(source);

    expect(result.serverNames).toEqual([]);
    expect(result.droppedServers).toEqual(['escape']);
    expect(result.diagnostics).toEqual([expect.stringContaining('escapes its allowed plugin directory')]);
  });

  it('skips a relative command that is not executable', () => {
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'not-executable'), '#!/bin/sh\n', { mode: 0o600 });
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: { blocked: { type: 'stdio', command: './bin/not-executable' } },
    });

    const result = normalize(source);

    expect(result.serverNames).toEqual([]);
    expect(result.diagnostics).toEqual([expect.stringContaining('must resolve to an executable file')]);
  });

  it('applies the domain allowlist before staging', () => {
    const source = writeConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: {
        keep: { type: 'stdio', command: 'node' },
        drop: { type: 'sse', url: 'http://127.0.0.1:3000/events' },
      },
    });

    const result = normalize(source, ['keep']);

    expect(result.serverNames).toEqual(['keep']);
    expect(result.droppedServers).toEqual(['drop']);
    expect(Object.keys(result.claudeConfig.mcpServers)).toEqual(['keep']);
  });
});
