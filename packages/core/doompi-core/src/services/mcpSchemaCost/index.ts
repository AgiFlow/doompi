import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIRECTORY = 'mcp-schema-cache';
const CACHE_VERSION = 1;
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 10_000;

interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpServerCost {
  name: string;
  tokens: number;
  toolCount: number;
  /** Read from the on-disk snapshot rather than a fresh handshake. */
  cached: boolean;
  /** Why this server could not be priced. Set only when tokens is 0. */
  unavailable?: string;
}

export interface McpSchemaCost {
  servers: McpServerCost[];
  totalTokens: number;
}

export interface McpSchemaCostOptions {
  /** The resolved MCP config Pi will load. */
  configPath: string;
  homeDoomDirectory: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  countTokens: (text: string) => number;
  timeoutMs?: number;
}

function asStdioServer(value: unknown): StdioServer | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== 'string' || !record.command) return undefined;
  const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const env =
    typeof record.env === 'object' && record.env !== null
      ? Object.fromEntries(
          Object.entries(record.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
  return { command: record.command, args, ...(env ? { env } : {}) };
}

function cachePath(server: StdioServer, homeDoomDirectory: string): string {
  const env = Object.entries(server.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const identity = [CACHE_VERSION, server.command, server.args, env];
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return path.join(homeDoomDirectory, CACHE_DIRECTORY, `${digest}.json`);
}

function readCache(file: string): { tokens: number; toolCount: number } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { tokens, toolCount } = parsed as Record<string, unknown>;
    if (typeof tokens !== 'number' || typeof toolCount !== 'number') return undefined;
    return { tokens, toolCount };
  } catch {
    return undefined;
  }
}

function writeCache(file: string, value: { tokens: number; toolCount: number }): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    // A cache that cannot be written only costs the next run a handshake.
  }
}

/**
 * Runs the MCP initialize/tools handshake and returns the advertised tools.
 *
 * The server is a configured executable, so this trusts it the same way a
 * session does, but it is killed as soon as the tool list arrives rather than
 * being left running.
 */
function listTools(server: StdioServer, options: McpSchemaCostOptions): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {
      cwd: options.cwd,
      env: { ...options.environment, ...server.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      outcome();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('timed out'))),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const send = (message: unknown): void => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: { tools?: unknown[] } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        }
        if (message.id === 2) finish(() => resolve(message.result?.tools ?? []));
      }
    });

    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', () => finish(() => reject(new Error('server exited before reporting tools'))));

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'doompi-explain', version: '1' },
      },
    });
  });
}

async function priceServer(name: string, configured: unknown, options: McpSchemaCostOptions): Promise<McpServerCost> {
  const server = asStdioServer(configured);
  if (!server) return { name, tokens: 0, toolCount: 0, cached: false, unavailable: 'not a stdio server' };

  const file = cachePath(server, options.homeDoomDirectory);
  const hit = readCache(file);
  if (hit) return { name, tokens: hit.tokens, toolCount: hit.toolCount, cached: true };

  try {
    const tools = await listTools(server, options);
    const value = { tokens: options.countTokens(JSON.stringify(tools)), toolCount: tools.length };
    writeCache(file, value);
    return { name, ...value, cached: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name, tokens: 0, toolCount: 0, cached: false, unavailable: detail };
  }
}

/**
 * Prices the tool schemas every configured MCP server puts in the system
 * prompt.
 *
 * Servers only report their tools once connected, so this spawns each one and
 * snapshots the result under the home Doom directory. Handshakes run in
 * parallel and the snapshot is keyed on the server descriptor, so a changed
 * command or pinned version re-prices and everything else stays instant.
 */
export async function priceMcpToolSchemas(options: McpSchemaCostOptions): Promise<McpSchemaCost> {
  const parsed = JSON.parse(fs.readFileSync(options.configPath, 'utf8')) as {
    mcpServers?: Record<string, unknown>;
  };
  const entries = Object.entries(parsed.mcpServers ?? {});
  const servers = await Promise.all(entries.map(([name, configured]) => priceServer(name, configured, options)));
  return { servers, totalTokens: servers.reduce((total, server) => total + server.tokens, 0) };
}
