import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { normalizeAgentPluginMcpSource } from '@agimon-ai/doompi-config/agentPluginMcp';
import type { DoomMcpNativeProjectionSource } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import type { McpConfigGroups, McpConfigGroupsInput, McpConfigSource } from '../../types/mcpConfig.ts';

/** Wrapper entry used by non-Doom clients to expose `mcp-config.yaml` as one MCP. */
export const PROXY_SERVER_NAME = 'mcp-proxy';

const PROXY_SERVER_ALIASES = new Set([PROXY_SERVER_NAME, 'agiflow-proxy']);
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DEFAULT_UPSTREAM_CONFIG = 'mcp-config.yaml';
const CONFIG_ARGUMENT = '--config';

type JsonObject = Record<string, unknown>;

interface FilteredLayer {
  source: McpConfigSource;
  kept: string[];
  dropped: string[];
}

interface ConfigDocument {
  config: JsonObject;
  contents: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYamlPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.yaml' || extension === '.yml';
}

function readConfigDocument(filePath: string): ConfigDocument | undefined {
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = isYamlPath(filePath) ? parseYaml(contents) : JSON.parse(contents);
    return isObject(parsed) ? { config: parsed, contents } : undefined;
  } catch {
    return undefined;
  }
}

function readConfigObject(filePath: string): JsonObject | undefined {
  return readConfigDocument(filePath)?.config;
}

function serverDefinitions(config: JsonObject | undefined): Record<string, unknown> {
  return isObject(config?.mcpServers) ? config.mcpServers : {};
}

function isEnabledDefinition(definition: unknown): boolean {
  return !isObject(definition) || definition.disabled !== true;
}

function isProxyWrapper(name: string): boolean {
  return PROXY_SERVER_ALIASES.has(name);
}

/**
 * Resolves the upstream config referenced by the repository proxy wrapper.
 *
 * The wrapper remains useful to Claude, Codex, and other external clients. Doom
 * embeds the same client/runtime code, so it reads this path and connects each
 * declared server itself instead of starting the wrapper as a nested MCP.
 */
function resolveSharedConfigPathFrom(repoRoot: string, repositoryConfigPath: string): string | undefined {
  const servers = serverDefinitions(readConfigObject(repositoryConfigPath));
  const proxy = [...PROXY_SERVER_ALIASES]
    .map((name) => servers[name])
    .find((definition): definition is JsonObject => isObject(definition));
  const rawArgs: unknown = proxy?.args;
  const args = Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [];
  const configArgumentIndex = args.indexOf(CONFIG_ARGUMENT);
  const declared = args[configArgumentIndex + 1];
  const candidate =
    configArgumentIndex >= 0 && typeof declared === 'string'
      ? path.resolve(repoRoot, declared)
      : path.join(repoRoot, DEFAULT_UPSTREAM_CONFIG);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function resolveSharedConfigPath(repoRoot: string): string | undefined {
  return resolveSharedConfigPathFrom(repoRoot, path.join(repoRoot, '.mcp.json'));
}

/** Empty and absent allowlists both mean "keep everything". */
function isAllowed(name: string, allowed: string[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(name);
}

function stagedPath(filePath: string, contents: string, stagingDirectory: string): string {
  // The filtered bytes are part of the identity because two live sessions can
  // select different domains. Sharing a path would let the later one rewrite the
  // configuration underneath the first one's deferred startup.
  const digest = createHash('sha256').update(filePath).update('\0').update(contents).digest('hex').slice(0, 16);
  const extension = isYamlPath(filePath) ? '.yaml' : '.json';
  return path.join(stagingDirectory, `mcp-${digest}${extension}`);
}

function serializeConfig(filePath: string, config: JsonObject): string {
  return isYamlPath(filePath) ? stringifyYaml(config) : `${JSON.stringify(config, null, 2)}\n`;
}

function layerCacheKey(
  filePath: string,
  format: McpConfigSource['format'],
  originalContents: string,
  effectiveContents: string,
  sourceIdentity?: string,
): string {
  return createHash('sha256')
    .update(format)
    .update('\0')
    .update(fs.realpathSync(filePath))
    .update('\0')
    .update(sourceIdentity ?? 'unprojected')
    .update('\0')
    .update(originalContents)
    .update('\0')
    .update(effectiveContents)
    .digest('hex');
}

/**
 * Rewrites one config layer with disallowed servers removed.
 *
 * Proxy wrapper entries are stripped from `.mcp.json` layers because Doom reaches
 * their upstream config directly. Entries are removed rather than marked disabled,
 * so a filtered stdio server is never spawned at all.
 */
function filterLayer(
  filePath: string,
  allowed: string[] | undefined,
  stagingDirectory: string,
  options: { stripProxyWrappers: boolean; sourceIdentity?: string },
): FilteredLayer | undefined {
  const document = readConfigDocument(filePath);
  if (!document) return undefined;
  const { config, contents: originalContents } = document;
  const servers = serverDefinitions(config);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [name, definition] of Object.entries(servers)) {
    const shouldDrop = (options.stripProxyWrappers && isProxyWrapper(name)) || !isAllowed(name, allowed);
    if (shouldDrop) dropped.push(name);
    else kept[name] = definition;
  }

  const keptNames = Object.entries(kept)
    .filter(([, definition]) => isEnabledDefinition(definition))
    .map(([name]) => name);
  if (dropped.length === 0) {
    return {
      source: {
        path: filePath,
        format: 'claude',
        cacheKey: layerCacheKey(filePath, 'claude', originalContents, originalContents, options.sourceIdentity),
      },
      kept: keptNames,
      dropped,
    };
  }

  fs.mkdirSync(stagingDirectory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const contents = serializeConfig(filePath, { ...config, mcpServers: kept });
  const target = stagedPath(filePath, contents, stagingDirectory);
  fs.writeFileSync(target, contents, { mode: PRIVATE_FILE_MODE });
  return {
    source: {
      path: target,
      format: 'claude',
      cacheKey: layerCacheKey(filePath, 'claude', originalContents, contents, options.sourceIdentity),
    },
    kept: keptNames,
    dropped,
  };
}

function digestMatches(source: DoomMcpNativeProjectionSource): boolean {
  try {
    const digest = createHash('sha256').update(fs.readFileSync(source.configPath)).digest('hex');
    return digest === source.contentDigest;
  } catch {
    return false;
  }
}

function emptyGroups(diagnostics: string[] = []): McpConfigGroups {
  return {
    shared: { configSources: [], configPaths: [], serverNames: [] },
    sessionLocal: { configSources: [], configPaths: [], serverNames: [] },
    droppedServers: [],
    diagnostics,
  };
}

/**
 * Resolves every config layer for this session and applies its domain allowlist.
 *
 * All returned layers go into one embedded `@agimon-ai/mcp-proxy` client container.
 * The package is used as a library only: its wrapper MCP never becomes a Doom MCP
 * server, so status, enable/disable, resources, and OAuth stay attached to each
 * actual downstream server.
 */
export function buildMcpConfigGroups(input: McpConfigGroupsInput): McpConfigGroups {
  if (input.enabled === false) return emptyGroups();

  const projectedSources = input.sources;
  const legacyLayers = projectedSources
    ? []
    : [
        path.join(input.repoRoot, '.mcp.json'),
        ...(input.pluginConfigPaths ?? []).map((candidate) => path.resolve(input.repoRoot, candidate)),
      ].filter((candidate) => fs.existsSync(candidate));

  const configSources: McpConfigSource[] = [];
  const serverNames: string[] = [];
  const droppedServers: string[] = [];
  const diagnostics: string[] = [];
  for (const layer of legacyLayers) {
    const filtered = filterLayer(layer, input.allowlist?.servers, input.stagingDirectory, {
      stripProxyWrappers: true,
    });
    if (!filtered) continue;
    configSources.push(filtered.source);
    serverNames.push(...filtered.kept);
    droppedServers.push(...filtered.dropped);
  }

  for (const source of projectedSources ?? []) {
    if (source.format === 'agent-plugin-v1') {
      const normalized = normalizeAgentPluginMcpSource(source, {
        stagingDirectory: input.stagingDirectory,
        allowedServers: input.allowlist?.servers,
      });
      if (normalized.configSource) configSources.push(normalized.configSource);
      serverNames.push(...normalized.serverNames);
      droppedServers.push(...normalized.droppedServers);
      diagnostics.push(...normalized.diagnostics);
      continue;
    }

    if (!digestMatches(source)) {
      diagnostics.push(
        `Native MCP source "${source.sourceId}" was disabled: the file is missing or its content digest changed.`,
      );
      continue;
    }
    const filtered = filterLayer(source.configPath, input.allowlist?.servers, input.stagingDirectory, {
      stripProxyWrappers: true,
      sourceIdentity: `${source.sourceId}:${source.contentDigest}`,
    });
    if (!filtered) {
      diagnostics.push(`Native MCP source "${source.sourceId}" was disabled: the config could not be parsed.`);
      continue;
    }
    configSources.push(filtered.source);
    serverNames.push(...filtered.kept);
    droppedServers.push(...filtered.dropped);
  }

  const repositorySource = projectedSources?.find(
    (source): source is DoomMcpNativeProjectionSource => source.format === 'native' && source.owner === 'repository',
  );
  const upstreamPath = projectedSources
    ? repositorySource && digestMatches(repositorySource)
      ? resolveSharedConfigPathFrom(input.repoRoot, repositorySource.configPath)
      : undefined
    : resolveSharedConfigPath(input.repoRoot);
  const upstream = upstreamPath
    ? filterLayer(upstreamPath, input.allowlist?.proxy, input.stagingDirectory, { stripProxyWrappers: true })
    : undefined;
  if (upstream) droppedServers.push(...upstream.dropped);

  return {
    shared: {
      configSources: upstream ? [upstream.source] : [],
      configPaths: upstream ? [upstream.source.path] : [],
      serverNames: upstream ? upstream.kept : [],
    },
    // A later layer overriding an earlier one contributes the same name twice.
    sessionLocal: {
      configSources,
      configPaths: configSources.map((source) => source.path),
      serverNames: [...new Set(serverNames)],
    },
    droppedServers: [...new Set(droppedServers)],
    diagnostics,
  };
}
