import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  applyMcpAllowlist,
  filterMcpServers,
  filterProxyConfig,
  persistMcpConfig,
  PROXY_SERVER_NAME,
  resolveMcpAllowlist,
} from '../../src/adapters/mcpFilter.ts';

const PROXY_YAML = `# comment
proxy:
  keepAlive: true
mcpServers:
  log-sink:
    type: stdio
    command: pnpm
  development-mcp:
    type: stdio
    command: node
  boomlink-staging:
    type: http
    url: https://example.invalid
skills:
  paths:
    - tools/skills
`;

describe('resolveMcpAllowlist', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-mcp-'));
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      [
        'plugins:',
        '  entries:',
        '    one: plugins/one',
        '    two: plugins/two',
        '    three: plugins/three',
        'domains:',
        '  scoped:',
        '    plugins: [one]',
        '    mcp:',
        '      servers: [alpha]',
        '      proxy: [log-sink]',
        '  alsoScoped:',
        '    plugins: [two]',
        '    mcp:',
        '      servers: [beta]',
        '      proxy: [other]',
        '  legacy:',
        '    plugins: [three]',
        'aliases:',
        '  combo: [scoped, alsoScoped]',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('unions the allowlists of the selected domains', () => {
    expect(resolveMcpAllowlist(root, ['combo'])).toEqual({
      servers: ['alpha', 'beta'],
      proxy: ['log-sink', 'other'],
    });
  });

  it('stays unfiltered when any selected domain has not opted in', () => {
    // A domain with no mcp key means "everything", so mixing it with a scoped
    // domain must not quietly strip the unscoped domain's tools.
    expect(resolveMcpAllowlist(root, ['scoped', 'legacy'])).toBeUndefined();
    expect(resolveMcpAllowlist(root, ['legacy'])).toBeUndefined();
  });

  it('stays unfiltered when nothing is selected', () => {
    expect(resolveMcpAllowlist(root, [])).toBeUndefined();
  });
});

describe('filterMcpServers', () => {
  const config = { mcpServers: { alpha: { a: 1 }, beta: { b: 2 } } };

  it('keeps only allowed servers', () => {
    expect(filterMcpServers(config, ['alpha'])).toEqual({ mcpServers: { alpha: { a: 1 } } });
  });

  it('keeps everything when the allowlist is absent or empty', () => {
    expect(filterMcpServers(config, undefined)).toEqual(config);
    expect(filterMcpServers(config, [])).toEqual(config);
  });

  it('tolerates a config that declares no servers at all', () => {
    expect(filterMcpServers({}, ['alpha'])).toEqual({ mcpServers: {} });
  });
});

describe('filterProxyConfig', () => {
  it('removes upstreams rather than disabling them', () => {
    const parsed = parseYaml(filterProxyConfig(PROXY_YAML, ['log-sink']));
    // Removal, not a disabled flag, so a filtered upstream cannot be reached
    // even if the proxy ignores `disabled`. Asserted against the parsed config
    // because the generated header names the dropped servers on purpose.
    expect(Object.keys(parsed.mcpServers)).toEqual(['log-sink']);
    expect(parsed.mcpServers['development-mcp']).toBeUndefined();
    expect(parsed.mcpServers['boomlink-staging']).toBeUndefined();
  });

  it('preserves unrelated top-level configuration', () => {
    const parsed = parseYaml(filterProxyConfig(PROXY_YAML, ['log-sink']));
    expect(parsed.proxy).toEqual({ keepAlive: true });
    expect(parsed.skills).toEqual({ paths: ['tools/skills'] });
  });

  it('records what it removed so a missing tool is traceable', () => {
    expect(filterProxyConfig(PROXY_YAML, ['log-sink'])).toContain('development-mcp, boomlink-staging');
  });

  it('says so explicitly when the allowlist keeps or drops nothing', () => {
    const emptied = filterProxyConfig('mcpServers: {}\n', ['log-sink']);
    expect(emptied).toContain('Upstreams kept: (none)');
    expect(emptied).toContain('removed by the domain allowlist: (none)');
  });

  it('returns the source untouched when unfiltered', () => {
    expect(filterProxyConfig(PROXY_YAML, undefined)).toBe(PROXY_YAML);
    expect(filterProxyConfig(PROXY_YAML, [])).toBe(PROXY_YAML);
  });
});

describe('applyMcpAllowlist', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-mcp-apply-'));
    fs.writeFileSync(path.join(root, 'mcp-config.yaml'), PROXY_YAML);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('repoints the proxy at a filtered config in the run directory', async () => {
    const config = {
      mcpServers: {
        [PROXY_SERVER_NAME]: { command: 'npx', args: ['mcp-serve', '--config', './mcp-config.yaml'] },
        'code-intel': { command: 'node' },
      },
    };

    const result = await applyMcpAllowlist(config, { servers: [PROXY_SERVER_NAME], proxy: ['log-sink'] }, root, root);
    const servers = result.mcpServers as Record<string, { args: string[] }>;

    expect(Object.keys(servers)).toEqual([PROXY_SERVER_NAME]);
    const configPath = servers[PROXY_SERVER_NAME]!.args[servers[PROXY_SERVER_NAME]!.args.indexOf('--config') + 1]!;
    expect(configPath).toBe(path.join(root, 'mcp-config.yaml'));
    expect(Object.keys(parseYaml(fs.readFileSync(configPath, 'utf8')).mcpServers)).toEqual(['log-sink']);
  });

  it('leaves the config alone when there is no allowlist', async () => {
    const config = { mcpServers: { alpha: {} } };
    expect(await applyMcpAllowlist(config, undefined, root, root)).toBe(config);
  });

  it('filters servers only when the selection names no proxy upstreams', async () => {
    const config = { mcpServers: { alpha: {}, beta: {} } };

    expect(await applyMcpAllowlist(config, { servers: ['alpha'], proxy: [] }, root, root)).toEqual({
      mcpServers: { alpha: {} },
    });
  });

  it('leaves a proxy that declares no --config option alone', async () => {
    const config = { mcpServers: { [PROXY_SERVER_NAME]: { command: 'npx', args: ['serve'] } } };

    expect(await applyMcpAllowlist(config, { servers: [], proxy: ['log-sink'] }, root, root)).toEqual(config);
  });

  it('leaves the proxy alone when its declared config file does not exist', async () => {
    const config = {
      mcpServers: { [PROXY_SERVER_NAME]: { command: 'npx', args: ['--config', './missing.yaml'] } },
    };

    expect(await applyMcpAllowlist(config, { servers: [], proxy: ['log-sink'] }, root, root)).toEqual(config);
  });
});

describe('persistMcpConfig', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-mcp-persist-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeGeneratedConfig(servers: Record<string, unknown>): string {
    const source = path.join(root, 'mcp.json');
    fs.writeFileSync(source, JSON.stringify({ mcpServers: servers }, null, 2));
    return source;
  }

  it('copies the config into the target directory, creating it if needed', async () => {
    const source = writeGeneratedConfig({ alpha: { command: 'alpha' } });
    const target = path.join(root, 'emitted', 'nested');

    const emitted = await persistMcpConfig(source, root, target);

    expect(emitted).toBe(path.join(target, 'mcp.json'));
    expect(JSON.parse(fs.readFileSync(emitted, 'utf8'))).toEqual({ mcpServers: { alpha: { command: 'alpha' } } });
  });

  it('relocates the proxy config beside the emitted config and repoints the proxy at it', async () => {
    const generatedProxyConfig = path.join(root, 'mcp-config.yaml');
    fs.writeFileSync(generatedProxyConfig, 'mcpServers:\n  upstream: {}\n');
    const source = writeGeneratedConfig({
      [PROXY_SERVER_NAME]: { command: 'npx', args: ['proxy', '--config', generatedProxyConfig] },
    });
    const target = path.join(root, 'emitted');

    const emitted = await persistMcpConfig(source, root, target);

    const config = JSON.parse(fs.readFileSync(emitted, 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const relocated = path.join(target, 'mcp-config.yaml');
    expect(config.mcpServers[PROXY_SERVER_NAME]?.args).toEqual(['proxy', '--config', relocated]);
    expect(fs.readFileSync(relocated, 'utf8')).toContain('upstream');
  });

  it('leaves the proxy untouched when the run directory holds no proxy config', async () => {
    const source = writeGeneratedConfig({
      [PROXY_SERVER_NAME]: { command: 'npx', args: ['proxy', '--config', '/elsewhere/mcp-config.yaml'] },
    });
    const target = path.join(root, 'emitted');
    // A run directory that never generated a filtered proxy config.
    const runDirectory = path.join(root, 'unfiltered-run');
    fs.mkdirSync(runDirectory);

    const emitted = await persistMcpConfig(source, runDirectory, target);

    const config = JSON.parse(fs.readFileSync(emitted, 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(config.mcpServers[PROXY_SERVER_NAME]?.args).toEqual(['proxy', '--config', '/elsewhere/mcp-config.yaml']);
    expect(fs.existsSync(path.join(target, 'mcp-config.yaml'))).toBe(false);
  });

  it('leaves a proxy that declares no config option alone', async () => {
    fs.writeFileSync(path.join(root, 'mcp-config.yaml'), 'mcpServers: {}\n');
    const source = writeGeneratedConfig({ [PROXY_SERVER_NAME]: { command: 'npx', args: ['proxy'] } });

    const emitted = await persistMcpConfig(source, root, path.join(root, 'emitted'));

    const config = JSON.parse(fs.readFileSync(emitted, 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(config.mcpServers[PROXY_SERVER_NAME]?.args).toEqual(['proxy']);
  });

  it('emits a config that declares no servers at all', async () => {
    const source = path.join(root, 'mcp.json');
    fs.writeFileSync(source, JSON.stringify({}));

    const emitted = await persistMcpConfig(source, root, path.join(root, 'emitted'));

    expect(JSON.parse(fs.readFileSync(emitted, 'utf8'))).toEqual({ mcpServers: {} });
  });
});
