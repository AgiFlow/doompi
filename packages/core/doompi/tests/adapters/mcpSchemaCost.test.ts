import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { priceMcpToolSchemas } from '../../src/adapters/mcpSchemaCost.ts';

const TOOLS = [{ name: 'search', description: 'Find things', inputSchema: { type: 'object' } }];

/** A server that completes the handshake and reports one tool. */
const RESPONSIVE = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n');
    if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: ${JSON.stringify(TOOLS)} } }) + '\\n');
    }
  }
});
`;

/** A server that connects and then never answers. */
const SILENT = `process.stdin.resume();`;

let root: string;
let home: string;

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-cost-'));
}

function writeConfig(servers: Record<string, unknown>): string {
  const configPath = path.join(root, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));
  return configPath;
}

function scriptServer(source: string): Record<string, unknown> {
  const file = path.join(root, `server-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, source);
  return { command: process.execPath, args: [file] };
}

function price(configPath: string, timeoutMs = 10_000): ReturnType<typeof priceMcpToolSchemas> {
  return priceMcpToolSchemas({
    configPath,
    homeDoomDirectory: home,
    cwd: root,
    environment: process.env,
    countTokens: (text) => text.length,
    timeoutMs,
  });
}

beforeEach(() => {
  root = workspace();
  home = workspace();
});

describe('priceMcpToolSchemas', () => {
  it('prices a stdio server from a real handshake and snapshots the result', async () => {
    const configPath = writeConfig({ docs: scriptServer(RESPONSIVE) });

    const first = await price(configPath);

    expect(first.servers).toHaveLength(1);
    expect(first.servers[0]).toMatchObject({ name: 'docs', toolCount: 1, cached: false });
    expect(first.servers[0].tokens).toBe(JSON.stringify(TOOLS).length);
    expect(first.totalTokens).toBe(first.servers[0].tokens);

    const second = await price(configPath);

    expect(second.servers[0]).toMatchObject({ tokens: first.servers[0].tokens, cached: true });
  });

  it('reuses the snapshot when only the server name changes, and re-prices when the command does', async () => {
    const server = scriptServer(RESPONSIVE);
    await price(writeConfig({ docs: server }));

    const renamed = await price(writeConfig({ handbook: server }));
    expect(renamed.servers[0]).toMatchObject({ name: 'handbook', cached: true });

    const rearmed = await price(writeConfig({ docs: { ...server, args: [...(server.args as string[]), '--v2'] } }));
    expect(rearmed.servers[0].cached).toBe(false);
  });

  it('sums every configured server', async () => {
    const configPath = writeConfig({ a: scriptServer(RESPONSIVE), b: scriptServer(RESPONSIVE) });

    const cost = await price(configPath);

    expect(cost.servers).toHaveLength(2);
    expect(cost.totalTokens).toBe(cost.servers[0].tokens + cost.servers[1].tokens);
  });

  it('names a server it cannot spawn rather than failing the whole report', async () => {
    const configPath = writeConfig({
      good: scriptServer(RESPONSIVE),
      missing: { command: path.join(root, 'does-not-exist'), args: [] },
    });

    const cost = await price(configPath);
    const missing = cost.servers.find((server) => server.name === 'missing');

    expect(missing).toMatchObject({ tokens: 0, toolCount: 0 });
    expect(missing?.unavailable).toBeTruthy();
    expect(cost.totalTokens).toBeGreaterThan(0);
  });

  it('times out a server that never reports its tools', async () => {
    const configPath = writeConfig({ silent: scriptServer(SILENT) });

    const cost = await price(configPath, 150);

    expect(cost.servers[0]).toMatchObject({ tokens: 0, unavailable: 'timed out' });
  });

  it('reports a server that exits before answering', async () => {
    const configPath = writeConfig({ quitter: scriptServer('process.exit(0);') });

    const cost = await price(configPath);

    expect(cost.servers[0].unavailable).toBe('server exited before reporting tools');
  });

  it('skips servers that are not stdio', async () => {
    const configPath = writeConfig({ remote: { url: 'https://example.invalid/mcp' }, broken: 'nonsense' });

    const cost = await price(configPath);

    expect(cost.servers.map((server) => server.unavailable)).toEqual(['not a stdio server', 'not a stdio server']);
    expect(cost.totalTokens).toBe(0);
  });

  it('re-measures when the snapshot on disk is unreadable', async () => {
    const configPath = writeConfig({ docs: scriptServer(RESPONSIVE) });
    await price(configPath);

    const cacheDirectory = path.join(home, 'mcp-schema-cache');
    for (const entry of fs.readdirSync(cacheDirectory)) {
      fs.writeFileSync(path.join(cacheDirectory, entry), 'not json');
    }

    const cost = await price(configPath);

    expect(cost.servers[0]).toMatchObject({ toolCount: 1, cached: false });
  });

  it('still reports a figure when the snapshot cannot be written', async () => {
    const configPath = writeConfig({ docs: scriptServer(RESPONSIVE) });
    fs.writeFileSync(path.join(home, 'mcp-schema-cache'), 'blocked');

    const cost = await price(configPath);

    expect(cost.servers[0]).toMatchObject({ toolCount: 1, cached: false });
    expect(cost.totalTokens).toBeGreaterThan(0);
  });

  it('passes configured env to the server and keys the snapshot on it', async () => {
    const echo = scriptServer(RESPONSIVE);
    await price(writeConfig({ docs: { ...echo, env: { TOKEN: 'a' } } }));

    const changed = await price(writeConfig({ docs: { ...echo, env: { TOKEN: 'b' } } }));

    expect(changed.servers[0].cached).toBe(false);
  });

  it('treats a config with no servers as free', async () => {
    const cost = await price(writeConfig({}));

    expect(cost).toEqual({ servers: [], totalTokens: 0 });
  });
});
