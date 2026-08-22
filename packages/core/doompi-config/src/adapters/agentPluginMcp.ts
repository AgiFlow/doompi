import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import {
  AGENT_PLUGIN_MCP_SCHEMA_URL,
  type DoomMcpAgentPluginProjectionSource,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const RESERVED_ENVIRONMENT_KEYS = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);
const PROXY_SERVER_ALIASES = new Set(['mcp-proxy', 'agiflow-proxy']);

type JsonObject = Record<string, unknown>;

export interface AgentPluginMcpConfigSource {
  path: string;
  format: 'internal';
  cacheKey: string;
}

export interface NormalizedAgentPluginMcpSource {
  /** Owner-only, content-addressed layer that bypasses Claude env interpolation. */
  configSource?: AgentPluginMcpConfigSource;
  /** Claude-compatible definitions for an external merged config. */
  claudeConfig: { mcpServers: Record<string, JsonObject> };
  serverNames: string[];
  droppedServers: string[];
  diagnostics: string[];
}

export interface NormalizeAgentPluginMcpOptions {
  stagingDirectory: string;
  /** Empty and absent lists both mean keep every server. */
  allowedServers?: readonly string[];
  /** Doom strips nested wrappers; external-only callers may opt out. */
  stripProxyWrappers?: boolean;
}

interface NormalizedServer {
  internal: JsonObject;
  claude: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field "${unexpected}"`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] must be a string`);
    return item;
  });
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${label} must be an object of string values`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string`);
      return [key, item];
    }),
  );
}

function expandPluginPlaceholders(value: string, pluginRoot: string, pluginDataDirectory: string): string {
  // The portable contract is a single, non-recursive replacement pass. An
  // unrecognised placeholder remains literal and mcp-proxy must not reinterpret it.
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/gu, (placeholder) =>
    placeholder === '${PLUGIN_ROOT}' ? pluginRoot : pluginDataDirectory,
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realContainedPath(root: string, candidate: string, label: string): string {
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new Error(`${label} does not exist`);
  }
  if (!isInside(root, realCandidate)) throw new Error(`${label} escapes its allowed plugin directory`);
  return realCandidate;
}

function normalizeCommand(command: string, pluginRoot: string): string {
  if (command.startsWith('./')) {
    const resolved = realContainedPath(pluginRoot, path.resolve(pluginRoot, command), 'command');
    if (!fs.statSync(resolved).isFile()) throw new Error('command must resolve to a regular file');
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
    } catch {
      throw new Error('command must resolve to an executable file');
    }
    return resolved;
  }
  if (command === '.' || command === '..' || /[\s/\\]/u.test(command)) {
    throw new Error('command must be a bare executable name or a ./ path inside the plugin');
  }
  return command;
}

function normalizeWorkingDirectory(declared: unknown, pluginRoot: string, pluginDataDirectory: string): string {
  if (declared === undefined) return pluginRoot;
  const cwd = nonEmptyString(declared, 'cwd');
  let base: string;
  let expanded: string;
  if (cwd.startsWith('./')) {
    base = pluginRoot;
    expanded = path.resolve(pluginRoot, cwd);
  } else if (cwd === '${PLUGIN_ROOT}' || cwd.startsWith('${PLUGIN_ROOT}/')) {
    base = pluginRoot;
    expanded = expandPluginPlaceholders(cwd, pluginRoot, pluginDataDirectory);
  } else if (cwd === '${PLUGIN_DATA}' || cwd.startsWith('${PLUGIN_DATA}/')) {
    base = pluginDataDirectory;
    expanded = expandPluginPlaceholders(cwd, pluginRoot, pluginDataDirectory);
  } else {
    throw new Error('cwd must start with ./, ${PLUGIN_ROOT}, or ${PLUGIN_DATA}');
  }
  const resolved = realContainedPath(base, path.resolve(expanded), 'cwd');
  if (!fs.statSync(resolved).isDirectory()) throw new Error('cwd must resolve to a directory');
  return resolved;
}

function normalizeEnvironment(value: unknown, pluginRoot: string, pluginDataDirectory: string): Record<string, string> {
  const declared = optionalStringRecord(value, 'env') ?? {};
  for (const key of Object.keys(declared)) {
    const reservedKey = process.platform === 'win32' ? key.toUpperCase() : key;
    if (RESERVED_ENVIRONMENT_KEYS.has(reservedKey)) {
      throw new Error(`env key "${key}" is reserved by Agent Plugins`);
    }
  }
  return {
    ...Object.fromEntries(
      Object.entries(declared).map(([key, item]) => [
        key,
        expandPluginPlaceholders(item, pluginRoot, pluginDataDirectory),
      ]),
    ),
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: pluginDataDirectory,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const bareHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bareHostname.toLowerCase() === 'localhost') return true;
  const family = isIP(bareHostname);
  if (family === 4) return bareHostname.split('.')[0] === '127';
  return family === 6 && bareHostname === '::1';
}

function normalizeUrl(value: unknown): string {
  const raw = nonEmptyString(value, 'url');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('url must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must use http or https');
  }
  if (parsed.username || parsed.password) throw new Error('url must not contain user information');
  if (parsed.hash) throw new Error('url must not contain a fragment');
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('non-loopback MCP URLs must use https');
  }
  return raw;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  const headers = optionalStringRecord(value, 'headers');
  if (!headers) return undefined;
  const seen = new Set<string>();
  for (const [name, item] of Object.entries(headers)) {
    const canonical = name.toLowerCase();
    if (seen.has(canonical)) throw new Error(`headers contain duplicate name "${name}"`);
    seen.add(canonical);
    try {
      validateHeaderName(name);
      validateHeaderValue(name, item);
    } catch {
      throw new Error(`header "${name}" is invalid`);
    }
  }
  return headers;
}

function normalizeServer(
  raw: unknown,
  pluginRoot: string,
  pluginDataDirectory: string,
  name: string,
): NormalizedServer {
  if (!isObject(raw)) throw new Error('definition must be an object');
  const type = nonEmptyString(raw.type, 'type');
  if (type === 'stdio') {
    onlyKeys(raw, ['type', 'command', 'args', 'env', 'cwd'], `server "${name}"`);
    const command = normalizeCommand(nonEmptyString(raw.command, 'command'), pluginRoot);
    const args = optionalStringArray(raw.args, 'args')?.map((item) =>
      expandPluginPlaceholders(item, pluginRoot, pluginDataDirectory),
    );
    const env = normalizeEnvironment(raw.env, pluginRoot, pluginDataDirectory);
    const cwd = normalizeWorkingDirectory(raw.cwd, pluginRoot, pluginDataDirectory);
    const config = { command, ...(args ? { args } : {}), env, cwd };
    return {
      internal: { name, transport: 'stdio', config },
      claude: { type: 'stdio', ...config },
    };
  }

  if (type === 'streamable-http' || type === 'sse') {
    onlyKeys(raw, ['type', 'url', 'headers'], `server "${name}"`);
    const url = normalizeUrl(raw.url);
    const headers = normalizeHeaders(raw.headers);
    const transport = type === 'streamable-http' ? 'http' : 'sse';
    const config = { url, ...(headers ? { headers } : {}) };
    return {
      internal: { name, transport, config },
      claude: { type: transport, ...config },
    };
  }

  throw new Error(`unsupported transport type "${type}"`);
}

function stagedInternalPath(
  source: DoomMcpAgentPluginProjectionSource,
  contents: string,
  stagingDirectory: string,
): string {
  const digest = createHash('sha256')
    .update(source.sourceId)
    .update('\0')
    .update(source.contentDigest)
    .update('\0')
    .update(contents)
    .digest('hex')
    .slice(0, 20);
  return path.join(stagingDirectory, `agent-plugin-mcp-${digest}.internal.json`);
}

function writeStagedInternalConfig(target: string, contents: string, stagingDirectory: string): void {
  fs.mkdirSync(stagingDirectory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  fs.chmodSync(stagingDirectory, PRIVATE_DIRECTORY_MODE);
  const temporaryPath = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    try {
      fs.renameSync(temporaryPath, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || fs.readFileSync(target, 'utf8') !== contents) {
        throw new Error('content-addressed staging path is occupied by different content');
      }
    }
    fs.chmodSync(target, PRIVATE_FILE_MODE);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function emptyResult(diagnostic: string): NormalizedAgentPluginMcpSource {
  return {
    claudeConfig: { mcpServers: {} },
    serverNames: [],
    droppedServers: [],
    diagnostics: [diagnostic],
  };
}

/**
 * Validates one Agent Plugins v1 `mcp.json` and stages a native mcp-proxy layer.
 *
 * Server validation is isolated: one malformed server is diagnosed and skipped.
 * Document/schema, source identity, or plugin-boundary failures reject the whole
 * source. Only the two portable plugin placeholders are expanded; the staged
 * layer is tagged `internal`, so legacy `${ENV}` interpolation cannot run again.
 */
export function normalizeAgentPluginMcpSource(
  source: DoomMcpAgentPluginProjectionSource,
  options: NormalizeAgentPluginMcpOptions,
): NormalizedAgentPluginMcpSource {
  const label = `Agent Plugin MCP source "${source.sourceId}"`;
  try {
    if (source.mcpSchemaUrl !== AGENT_PLUGIN_MCP_SCHEMA_URL) {
      throw new Error(`unsupported schema "${String(source.mcpSchemaUrl)}"`);
    }
    if (!path.isAbsolute(source.pluginRoot) || !path.isAbsolute(source.pluginDataDirectory)) {
      throw new Error('pluginRoot and pluginDataDirectory must be absolute');
    }
    const pluginRoot = fs.realpathSync(source.pluginRoot);
    try {
      const dataStat = fs.lstatSync(source.pluginDataDirectory);
      if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
        throw new Error('pluginDataDirectory must be a real directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(source.pluginDataDirectory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    }
    fs.chmodSync(source.pluginDataDirectory, PRIVATE_DIRECTORY_MODE);
    fs.accessSync(source.pluginDataDirectory, fs.constants.W_OK);
    const pluginDataDirectory = fs.realpathSync(source.pluginDataDirectory);
    const configPath = realContainedPath(pluginRoot, source.configPath, 'mcp.json');
    if (path.dirname(configPath) !== pluginRoot || path.basename(configPath) !== 'mcp.json') {
      throw new Error('portable plugin config must be root mcp.json');
    }

    const bytes = fs.readFileSync(configPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== source.contentDigest) throw new Error('content digest does not match the projection');
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isObject(parsed)) throw new Error('document must be an object');
    onlyKeys(parsed, ['$schema', 'mcpServers'], label);
    if (parsed.$schema !== source.mcpSchemaUrl) throw new Error('$schema does not match the projected schema');
    if (!isObject(parsed.mcpServers)) throw new Error('mcpServers must be an object');

    const allowed = options.allowedServers;
    const keepAll = !allowed || allowed.length === 0;
    const stripProxyWrappers = options.stripProxyWrappers ?? true;
    const internalServers = Object.create(null) as Record<string, JsonObject>;
    const claudeServers = Object.create(null) as Record<string, JsonObject>;
    const droppedServers: string[] = [];
    const diagnostics: string[] = [];

    for (const [name, rawServer] of Object.entries(parsed.mcpServers)) {
      if (!name) {
        diagnostics.push(`${label} contains an empty server name; that entry was skipped.`);
        continue;
      }
      if ((!keepAll && !allowed.includes(name)) || (stripProxyWrappers && PROXY_SERVER_ALIASES.has(name))) {
        droppedServers.push(name);
        continue;
      }
      try {
        const normalized = normalizeServer(rawServer, pluginRoot, pluginDataDirectory, name);
        internalServers[name] = normalized.internal;
        claudeServers[name] = normalized.claude;
      } catch (error) {
        droppedServers.push(name);
        diagnostics.push(
          `${label} skipped server "${name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const internalConfig = { mcpServers: internalServers };
    const contents = `${JSON.stringify(internalConfig, null, 2)}\n`;
    const target = stagedInternalPath(source, contents, options.stagingDirectory);
    writeStagedInternalConfig(target, contents, options.stagingDirectory);
    const cacheKey = createHash('sha256')
      .update('agent-plugin-v1\0')
      .update(source.sourceId)
      .update('\0')
      .update(source.contentDigest)
      .update('\0')
      .update(configPath)
      .update('\0')
      .update(contents)
      .digest('hex');

    return {
      configSource: { path: target, format: 'internal', cacheKey },
      claudeConfig: { mcpServers: claudeServers },
      serverNames: Object.keys(internalServers),
      droppedServers,
      diagnostics,
    };
  } catch (error) {
    return emptyResult(`${label} was disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}
