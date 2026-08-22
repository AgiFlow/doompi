import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildMcpConfigGroups,
  PROXY_SERVER_NAME,
  resolveSharedConfigPath,
} from '../src/adapters/node/configSources.ts';
import { definitionsCachePath } from '../src/adapters/node/mcpRuntime.ts';

let repoRoot: string;
let stagingDirectory: string;

function writeJson(relativePath: string, value: unknown): string {
  const target = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
  return target;
}

function rootConfig(servers: Record<string, unknown> = {}): void {
  writeJson('.mcp.json', {
    mcpServers: {
      [PROXY_SERVER_NAME]: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@agimon-ai/mcp-proxy@latest', 'mcp-serve', '--config', './mcp-config.yaml'],
      },
      ...servers,
    },
  });
}

function readServers(configPath: string): string[] {
  const content = fs.readFileSync(configPath, 'utf8');
  const parsed = (configPath.endsWith('.yaml') ? parseYaml(content) : JSON.parse(content)) as {
    mcpServers: Record<string, unknown>;
  };
  return Object.keys(parsed.mcpServers);
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-repo-'));
  stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-stage-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
});

describe('resolveSharedConfigPath', () => {
  it('reads the path off the proxy entry so a relocated config still resolves', () => {
    rootConfig();
    fs.writeFileSync(path.join(repoRoot, 'mcp-config.yaml'), 'mcpServers: {}\n');

    expect(resolveSharedConfigPath(repoRoot)).toBe(path.join(repoRoot, 'mcp-config.yaml'));
  });

  it('follows a non-default location declared on the proxy entry', () => {
    writeJson('.mcp.json', {
      mcpServers: {
        [PROXY_SERVER_NAME]: {
          type: 'stdio',
          command: 'npx',
          args: ['mcp-serve', '--config', './config/upstreams.yaml'],
        },
      },
    });
    fs.mkdirSync(path.join(repoRoot, 'config'));
    fs.writeFileSync(path.join(repoRoot, 'config', 'upstreams.yaml'), 'mcpServers: {}\n');

    expect(resolveSharedConfigPath(repoRoot)).toBe(path.join(repoRoot, 'config', 'upstreams.yaml'));
  });

  it('accepts the former agiflow-proxy wrapper name', () => {
    writeJson('.mcp.json', {
      mcpServers: {
        'agiflow-proxy': {
          command: 'mcp-proxy',
          args: ['mcp-serve', '--config', './config/upstreams.yaml'],
        },
      },
    });
    fs.mkdirSync(path.join(repoRoot, 'config'));
    fs.writeFileSync(path.join(repoRoot, 'config', 'upstreams.yaml'), 'mcpServers: {}\n');

    expect(resolveSharedConfigPath(repoRoot)).toBe(path.join(repoRoot, 'config', 'upstreams.yaml'));
  });

  it('reports nothing when the declared config is missing', () => {
    rootConfig();

    expect(resolveSharedConfigPath(repoRoot)).toBeUndefined();
  });
});

describe('buildMcpConfigGroups', () => {
  it('keeps the shared config out of the session group', () => {
    rootConfig({ pencil: { type: 'stdio', command: 'pencil' } });
    fs.writeFileSync(path.join(repoRoot, 'mcp-config.yaml'), 'mcpServers: {}\n');

    const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory });

    expect(groups.shared.configPaths).toEqual([path.join(repoRoot, 'mcp-config.yaml')]);
    expect(groups.shared.serverNames).toEqual([]);
    expect(groups.sessionLocal.configPaths).toHaveLength(1);
    expect(groups.sessionLocal.configPaths[0]).not.toContain('mcp-config.yaml');
  });

  it('strips proxy wrappers so Doom never exposes or spawns them', () => {
    rootConfig({
      'agiflow-proxy': { type: 'stdio', command: 'legacy-proxy' },
      pencil: { type: 'stdio', command: 'pencil' },
    });

    const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory });

    expect(readServers(groups.sessionLocal.configPaths[0])).toEqual(['pencil']);
    expect(groups.droppedServers).toEqual(expect.arrayContaining([PROXY_SERVER_NAME, 'agiflow-proxy']));
  });

  it('also strips a nested proxy wrapper from the referenced upstream config', () => {
    rootConfig();
    fs.writeFileSync(
      path.join(repoRoot, 'mcp-config.yaml'),
      'mcpServers:\n  mcp-proxy:\n    command: nested-proxy\n  log-sink:\n    command: log-sink\n',
    );

    const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory });

    expect(readServers(groups.shared.configPaths[0])).toEqual(['log-sink']);
    expect(groups.shared.serverNames).toEqual(['log-sink']);
    expect(groups.droppedServers).toContain(PROXY_SERVER_NAME);
  });

  it('leaves the repository .mcp.json on disk untouched', () => {
    rootConfig({ pencil: { type: 'stdio', command: 'pencil' } });

    buildMcpConfigGroups({ repoRoot, stagingDirectory });

    expect(readServers(path.join(repoRoot, '.mcp.json'))).toContain(PROXY_SERVER_NAME);
  });

  it('orders plugin layers after the repository layer', () => {
    rootConfig({ pencil: { type: 'stdio', command: 'pencil' } });
    const pluginConfig = writeJson('plugins/design/.mcp.json', {
      mcpServers: { rive: { type: 'stdio', command: 'rive' } },
    });

    const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory, pluginConfigPaths: [pluginConfig] });

    expect(groups.sessionLocal.configPaths).toHaveLength(2);
    // The plugin layer carries no proxy entry, so it needs no filtered copy.
    expect(groups.sessionLocal.configPaths[1]).toBe(pluginConfig);
  });

  it('invalidates warm definitions when a projected native path changes content', () => {
    const configPath = writeJson('.mcp.json', {
      mcpServers: { design: { type: 'stdio', command: 'design-v1' } },
    });
    const firstContents = fs.readFileSync(configPath);
    const first = buildMcpConfigGroups({
      repoRoot,
      stagingDirectory,
      sources: [
        {
          sourceId: 'repository:mcp',
          owner: 'repository',
          format: 'native',
          configPath,
          contentDigest: createHash('sha256').update(firstContents).digest('hex'),
        },
      ],
    });
    writeJson('.mcp.json', {
      mcpServers: { design: { type: 'http', url: 'https://mcp.example.test/v2' } },
    });
    const secondContents = fs.readFileSync(configPath);
    const second = buildMcpConfigGroups({
      repoRoot,
      stagingDirectory,
      sources: [
        {
          sourceId: 'repository:mcp',
          owner: 'repository',
          format: 'native',
          configPath,
          contentDigest: createHash('sha256').update(secondContents).digest('hex'),
        },
      ],
    });

    expect(first.sessionLocal.configSources[0]?.path).toBe(second.sessionLocal.configSources[0]?.path);
    expect(first.sessionLocal.configSources[0]?.cacheKey).not.toBe(second.sessionLocal.configSources[0]?.cacheKey);
    expect(definitionsCachePath(first.sessionLocal.configSources)).not.toBe(
      definitionsCachePath(second.sessionLocal.configSources),
    );
  });

  it('retains the canonical native origin in cache identity', () => {
    const value = { mcpServers: { design: { type: 'stdio', command: './bin/server' } } };
    const firstPath = writeJson('first/.mcp.json', value);
    const secondPath = writeJson('second/.mcp.json', value);
    const contentDigest = createHash('sha256').update(fs.readFileSync(firstPath)).digest('hex');
    const groupsFor = (configPath: string) =>
      buildMcpConfigGroups({
        repoRoot,
        stagingDirectory,
        sources: [
          {
            sourceId: 'repository:mcp',
            owner: 'repository',
            format: 'native',
            configPath,
            contentDigest,
          },
        ],
      });

    expect(groupsFor(firstPath).sessionLocal.configSources[0]?.cacheKey).not.toBe(
      groupsFor(secondPath).sessionLocal.configSources[0]?.cacheKey,
    );
  });

  it('skips plugin layers that do not exist', () => {
    rootConfig();

    const groups = buildMcpConfigGroups({
      repoRoot,
      stagingDirectory,
      pluginConfigPaths: [path.join(repoRoot, 'plugins/absent/.mcp.json')],
    });

    expect(groups.sessionLocal.configPaths).toHaveLength(1);
  });

  it('gives two plugins with the same basename distinct filtered copies', () => {
    rootConfig();
    const first = writeJson('plugins/a/.mcp.json', {
      mcpServers: { keep: { type: 'stdio', command: 'a' }, drop: { type: 'stdio', command: 'a' } },
    });
    const second = writeJson('plugins/b/.mcp.json', {
      mcpServers: { keep: { type: 'stdio', command: 'b' }, drop: { type: 'stdio', command: 'b' } },
    });

    const groups = buildMcpConfigGroups({
      repoRoot,
      stagingDirectory,
      pluginConfigPaths: [first, second],
      allowlist: { servers: ['keep'] },
    });

    const [, firstStaged, secondStaged] = groups.sessionLocal.configPaths;
    expect(firstStaged).not.toBe(secondStaged);
    expect(JSON.parse(fs.readFileSync(firstStaged, 'utf8')).mcpServers.keep.command).toBe('a');
    expect(JSON.parse(fs.readFileSync(secondStaged, 'utf8')).mcpServers.keep.command).toBe('b');
  });

  describe('domain allowlist', () => {
    it('removes disallowed servers from the layer so they are never spawned', () => {
      rootConfig({
        pencil: { type: 'stdio', command: 'pencil' },
        xcode: { type: 'stdio', command: 'xcrun' },
      });

      const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory, allowlist: { servers: ['pencil'] } });

      expect(readServers(groups.sessionLocal.configPaths[0])).toEqual(['pencil']);
      expect(groups.droppedServers).toEqual(expect.arrayContaining([PROXY_SERVER_NAME, 'xcode']));
    });

    it('writes the filtered copy owner-only', () => {
      rootConfig({ pencil: { type: 'stdio', command: 'pencil' } });

      const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory, allowlist: { servers: ['pencil'] } });

      const mode = fs.statSync(groups.sessionLocal.configPaths[0]).mode & 0o777;
      expect(mode.toString(8)).toBe('600');
    });

    it('treats an empty server list as keeping everything', () => {
      rootConfig({ pencil: { type: 'stdio', command: 'pencil' }, xcode: { type: 'stdio', command: 'xcrun' } });

      const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory, allowlist: { servers: [] } });

      expect(readServers(groups.sessionLocal.configPaths[0])).toEqual(['pencil', 'xcode']);
    });

    it('filters upstreams before the embedded client can connect to them', () => {
      rootConfig();
      const upstreamConfig = path.join(repoRoot, 'mcp-config.yaml');
      fs.writeFileSync(
        upstreamConfig,
        'mcpServers:\n  log-sink:\n    command: log-sink\n  browse-tool:\n    command: browse-tool\n',
      );

      const groups = buildMcpConfigGroups({
        repoRoot,
        stagingDirectory,
        allowlist: { servers: [], proxy: ['log-sink'] },
      });

      expect(groups.shared.configPaths[0]).not.toBe(upstreamConfig);
      expect(readServers(groups.shared.configPaths[0])).toEqual(['log-sink']);
      expect(groups.shared.serverNames).toEqual(['log-sink']);
      expect(groups.droppedServers).toContain('browse-tool');
      expect(fs.readFileSync(upstreamConfig, 'utf8')).toContain('browse-tool');
    });

    it('uses distinct staged paths for simultaneous sessions with different allowlists', () => {
      rootConfig();
      fs.writeFileSync(
        path.join(repoRoot, 'mcp-config.yaml'),
        'mcpServers:\n  log-sink:\n    command: log-sink\n  browse-tool:\n    command: browse-tool\n',
      );

      const logs = buildMcpConfigGroups({ repoRoot, stagingDirectory, allowlist: { proxy: ['log-sink'] } });
      const browser = buildMcpConfigGroups({ repoRoot, stagingDirectory, allowlist: { proxy: ['browse-tool'] } });

      expect(logs.shared.configPaths[0]).not.toBe(browser.shared.configPaths[0]);
      expect(readServers(logs.shared.configPaths[0])).toEqual(['log-sink']);
      expect(readServers(browser.shared.configPaths[0])).toEqual(['browse-tool']);
    });

    it('keeps every enabled upstream when the allowlist is empty', () => {
      rootConfig();
      fs.writeFileSync(
        path.join(repoRoot, 'mcp-config.yaml'),
        'mcpServers:\n  log-sink:\n    command: log-sink\n  disabled-server:\n    command: disabled\n    disabled: true\n',
      );

      const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory, allowlist: { proxy: [] } });

      expect(groups.shared.configPaths).toEqual([path.join(repoRoot, 'mcp-config.yaml')]);
      expect(groups.shared.serverNames).toEqual(['log-sink']);
    });
  });

  it('reports no session layers when the repository has no .mcp.json', () => {
    const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory });

    expect(groups.sessionLocal.configPaths).toEqual([]);
    expect(groups.shared.configPaths).toEqual([]);
  });

  it('skips a layer that is not valid JSON rather than failing the session', () => {
    rootConfig();
    const broken = path.join(repoRoot, 'plugins', 'broken', '.mcp.json');
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, '{ not json');

    const groups = buildMcpConfigGroups({ repoRoot, stagingDirectory, pluginConfigPaths: [broken] });

    expect(groups.sessionLocal.configPaths).toHaveLength(1);
  });
});
