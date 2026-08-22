import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import type { PluginEntry, PluginSkillDiscovery } from '@agimon-ai/doompi-config/domains';
import { normalizeAgentPluginMcpSource } from '@agimon-ai/doompi-config/agentPluginMcp';
import {
  AGENT_PLUGIN_MCP_SCHEMA_URL,
  DOOM_MCP_PROJECTION_VERSION,
  type DoomMcpProjection,
  type DoomMcpProjectionSource,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { parse, stringify } from 'yaml';
import { toPiToolName } from '../services/toolNames.ts';
import type {
  HarnessResourceOptions,
  HarnessResources,
  JsonObject,
  McpResourceOptions,
  NamedResource,
  StagedMcpResources,
} from '../types/resources.ts';
import type { PluginHookSource } from '@agimon-ai/doompi-config/types';
import { applyMcpAllowlist } from './mcpFilter.ts';
import { resolveSkillCacheDirectory } from './skillCacheLocation.ts';

export const DISPATCHER_AGENT_NAME = 'agiflow-dispatcher';
const DISPATCHER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'launch_workflow', 'list_workflows'];
const SKILL_MANIFEST_VERSION = 2;
const SKILL_MANIFEST_HASH_LENGTH = 16;
const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const PLUGIN_DATA_DIRECTORY = 'plugin-data';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!isJsonObject(candidate)) return candidate;
    return Object.fromEntries(
      Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function projectionFingerprint(input: Omit<DoomMcpProjection, 'fingerprint' | 'stagingDirectory'>): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function stablePluginIdentity(entry: PluginEntry): string {
  const source = entry.source;
  const identity =
    source?.type === 'git'
      ? ['git', source.url, source.path ?? '']
      : source?.type === 'npm'
        ? ['npm', source.registry ?? '', source.package]
        : ['local', fs.realpathSync(entry.directory)];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function rootAgentPluginSchema(entry: PluginEntry): string | undefined {
  const manifestPath = path.join(entry.directory, 'plugin.json');
  if (entry.manifest?.path === manifestPath && entry.manifest.agentPluginSchema === AGENT_PLUGIN_SCHEMA) {
    return AGENT_PLUGIN_SCHEMA;
  }
  try {
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    return isJsonObject(parsed) && parsed.$schema === AGENT_PLUGIN_SCHEMA ? AGENT_PLUGIN_SCHEMA : undefined;
  } catch {
    return undefined;
  }
}

async function pluginMcpSource(
  entry: PluginEntry,
  pluginDataRoot: string,
): Promise<DoomMcpProjectionSource | undefined> {
  if (entry.mcp === false) return undefined;
  const pluginRoot = fs.realpathSync(entry.directory);
  const agentPlugin = rootAgentPluginSchema(entry) === AGENT_PLUGIN_SCHEMA;
  const configPath = path.join(pluginRoot, agentPlugin ? 'mcp.json' : '.mcp.json');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  const content = await fs.promises.readFile(configPath);
  const contentDigest = createHash('sha256').update(content).digest('hex');
  const pluginId = stablePluginIdentity(entry);
  const sourceId = `plugin:${pluginId}`;
  if (!agentPlugin) return { sourceId, owner: 'plugin', format: 'native', configPath, contentDigest };
  return {
    sourceId,
    owner: 'plugin',
    format: 'agent-plugin-v1',
    configPath,
    contentDigest,
    pluginId,
    pluginRoot,
    pluginDataDirectory: path.join(pluginDataRoot, pluginId),
    mcpSchemaUrl: AGENT_PLUGIN_MCP_SCHEMA_URL,
  };
}

interface SkillManifestFile {
  path: string;
  name: string;
  digest: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SkillManifestDirectory {
  path: string;
  mtimeMs: number;
  ctimeMs: number;
}

interface SkillManifest {
  version: number;
  root: string;
  discovery: PluginSkillDiscovery;
  files: SkillManifestFile[];
  directories: SkillManifestDirectory[];
}

function splitFrontmatter(content: string): { attributes: JsonObject; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('Resource is missing YAML frontmatter');
  return { attributes: parse(match[1]!) as JsonObject, body: match[2] ?? '' };
}

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic/claude-sonnet-4-6',
  opus: 'anthropic/claude-opus-4-6',
  haiku: 'anthropic/claude-haiku-4-5',
};

function assertSafeAgentName(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed !== name ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0') ||
    /[\\/]/.test(trimmed)
  ) {
    throw new Error(`Unsafe agent name: ${JSON.stringify(name)}`);
  }
  return trimmed;
}

function normalizeClaudeModel(value: unknown): unknown {
  if (typeof value === 'string') return CLAUDE_MODEL_ALIASES[value.toLowerCase()] ?? value;
  if (Array.isArray(value)) return value.map((entry) => normalizeClaudeModel(entry));
  return value;
}

/** Rewrites a Claude-authored agent definition into the form Pi loads. */
export function adaptAgentDefinition(content: string): { name: string; content: string } {
  const { attributes, body } = splitFrontmatter(content);
  const rawName = typeof attributes.name === 'string' ? attributes.name : undefined;
  if (!rawName) throw new Error('Agent definition requires a name');
  const name = assertSafeAgentName(rawName);
  const hasTools = Object.hasOwn(attributes, 'tools');
  const rawTools = Array.isArray(attributes.tools)
    ? attributes.tools.map(String)
    : typeof attributes.tools === 'string'
      ? attributes.tools
          .split(',')
          .map((tool) => tool.trim())
          .filter(Boolean)
      : [];
  const mappedTools = [...new Set(rawTools.map(toPiToolName).filter((tool): tool is string => Boolean(tool)))];
  const converted: JsonObject = {
    ...attributes,
    inheritProjectContext: true,
    inheritSkills: true,
    systemPromptMode: attributes.systemPromptMode ?? 'replace',
  };
  if (hasTools) converted.tools = Array.isArray(attributes.tools) ? mappedTools : mappedTools.join(', ');
  else delete converted.tools;
  if (converted.model !== undefined) converted.model = normalizeClaudeModel(converted.model);
  if (converted.fallbackModels !== undefined) converted.fallbackModels = normalizeClaudeModel(converted.fallbackModels);
  if (converted.memory === 'project' || converted.memory === 'user')
    converted.memory = { scope: converted.memory, path: name };
  else if (
    converted.memory !== undefined &&
    (typeof converted.memory !== 'object' || converted.memory === null || Array.isArray(converted.memory))
  )
    throw new Error('Unsupported memory declaration');
  delete converted.permissionMode;
  return { name, content: `---\n${stringify(converted).trim()}\n---\n\n${body.trimStart()}` };
}

function skillManifestPath(
  repoRoot: string,
  skillRoot: string,
  discovery: PluginSkillDiscovery,
  cacheDirectory?: string,
): string {
  const key = createHash('sha256')
    .update(`${path.resolve(skillRoot)}\0${discovery}`)
    .digest('hex')
    .slice(0, SKILL_MANIFEST_HASH_LENGTH);
  return path.join(cacheDirectory ?? resolveSkillCacheDirectory(repoRoot), `${key}.json`);
}

function fileMatches(previous: SkillManifestFile): boolean {
  try {
    const stat = fs.statSync(previous.path);
    return (
      stat.isFile() &&
      stat.size === previous.size &&
      stat.mtimeMs === previous.mtimeMs &&
      stat.ctimeMs === previous.ctimeMs
    );
  } catch {
    return false;
  }
}

function directoryMatches(previous: SkillManifestDirectory): boolean {
  try {
    const stat = fs.statSync(previous.path);
    return stat.isDirectory() && stat.mtimeMs === previous.mtimeMs && stat.ctimeMs === previous.ctimeMs;
  } catch {
    return false;
  }
}

function readSkillManifest(
  manifestPath: string,
  root: string,
  discovery: PluginSkillDiscovery,
): SkillManifest | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SkillManifest;
    if (
      manifest.version !== SKILL_MANIFEST_VERSION ||
      manifest.root !== path.resolve(root) ||
      manifest.discovery !== discovery ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.directories) ||
      !manifest.files.every(fileMatches) ||
      !manifest.directories.every(directoryMatches)
    ) {
      return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
}

function writeSkillManifest(manifestPath: string, manifest: SkillManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporary, manifestPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(manifestPath)) throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readSkillManifestAsync(
  manifestPath: string,
  root: string,
  discovery: PluginSkillDiscovery,
): Promise<SkillManifest | undefined> {
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as SkillManifest;
    if (
      manifest.version !== SKILL_MANIFEST_VERSION ||
      manifest.root !== path.resolve(root) ||
      manifest.discovery !== discovery ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.directories)
    ) {
      return undefined;
    }
    for (const previous of manifest.files) {
      const stat = await fs.promises.stat(previous.path);
      if (
        !stat.isFile() ||
        stat.size !== previous.size ||
        stat.mtimeMs !== previous.mtimeMs ||
        stat.ctimeMs !== previous.ctimeMs
      ) {
        return undefined;
      }
    }
    for (const previous of manifest.directories) {
      const stat = await fs.promises.stat(previous.path);
      if (!stat.isDirectory() || stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs) {
        return undefined;
      }
    }
    return manifest;
  } catch {
    return undefined;
  }
}

async function writeSkillManifestAsync(manifestPath: string, manifest: SkillManifest): Promise<void> {
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.promises.rename(temporary, manifestPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    if (!(await pathExists(manifestPath))) throw error;
  }
}

function scanSkillManifest(root: string, discovery: PluginSkillDiscovery): SkillManifest {
  const directories: SkillManifestDirectory[] = [];
  const files: SkillManifestFile[] = [];
  const walk = (directory: string, depth: number): void => {
    if (!fs.existsSync(directory)) return;
    const directoryStat = fs.statSync(directory);
    directories.push({ path: directory, mtimeMs: directoryStat.mtimeMs, ctimeMs: directoryStat.ctimeMs });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (discovery === 'recursive' || depth === 0) walk(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md' || (discovery === 'direct-children' && depth !== 1)) {
        continue;
      }
      const content = fs.readFileSync(candidate, 'utf8');
      const { attributes } = splitFrontmatter(content);
      if (typeof attributes.name !== 'string') throw new Error(`Resource requires a name: ${candidate}`);
      const stat = fs.statSync(candidate);
      files.push({
        path: candidate,
        name: attributes.name,
        digest: createHash('sha256').update(content).digest('hex'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    }
  };
  const resolvedRoot = path.resolve(root);
  walk(resolvedRoot, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.path.localeCompare(right.path));
  return { version: SKILL_MANIFEST_VERSION, root: resolvedRoot, discovery, files, directories };
}

/** Cached skill metadata and exact files, ready for Pi without a second tree walk. */
export function discoverSkills(
  repoRoot: string,
  root: string,
  discovery: PluginSkillDiscovery = 'recursive',
  cacheDirectory?: string,
): NamedResource[] {
  if (!fs.existsSync(root)) return [];
  const manifestPath = skillManifestPath(repoRoot, root, discovery, cacheDirectory);
  const cached = readSkillManifest(manifestPath, root, discovery);
  const manifest = cached ?? scanSkillManifest(root, discovery);
  if (!cached) writeSkillManifest(manifestPath, manifest);
  return manifest.files.map(({ name, path: filePath, digest }) => ({ name, path: filePath, digest }));
}

async function scanSkillManifestAsync(root: string, discovery: PluginSkillDiscovery): Promise<SkillManifest> {
  const directories: SkillManifestDirectory[] = [];
  const files: SkillManifestFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      const directoryStat = await fs.promises.stat(directory);
      directories.push({ path: directory, mtimeMs: directoryStat.mtimeMs, ctimeMs: directoryStat.ctimeMs });
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (discovery === 'recursive' || depth === 0) await walk(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md' || (discovery === 'direct-children' && depth !== 1)) {
        continue;
      }
      const content = await fs.promises.readFile(candidate, 'utf8');
      const { attributes } = splitFrontmatter(content);
      if (typeof attributes.name !== 'string') throw new Error(`Resource requires a name: ${candidate}`);
      const stat = await fs.promises.stat(candidate);
      files.push({
        path: candidate,
        name: attributes.name,
        digest: createHash('sha256').update(content).digest('hex'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    }
  };
  const resolvedRoot = path.resolve(root);
  await walk(resolvedRoot, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.path.localeCompare(right.path));
  return { version: SKILL_MANIFEST_VERSION, root: resolvedRoot, discovery, files, directories };
}

export async function discoverSkillsAsync(
  repoRoot: string,
  root: string,
  discovery: PluginSkillDiscovery = 'recursive',
  cacheDirectory?: string,
): Promise<NamedResource[]> {
  if (!(await pathExists(root))) return [];
  const manifestPath = skillManifestPath(repoRoot, root, discovery, cacheDirectory);
  const cached = await readSkillManifestAsync(manifestPath, root, discovery);
  const manifest = cached ?? (await scanSkillManifestAsync(root, discovery));
  if (!cached) await writeSkillManifestAsync(manifestPath, manifest);
  return manifest.files.map(({ name, path: filePath, digest }) => ({ name, path: filePath, digest }));
}

async function markdownFilesAsync(directory: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await markdownFilesAsync(candidate)));
    if (entry.isFile() && entry.name.endsWith('.md')) results.push(candidate);
  }
  return results;
}

async function frontmatterNameAsync(filePath: string): Promise<string> {
  const { attributes } = splitFrontmatter(await fs.promises.readFile(filePath, 'utf8'));
  if (typeof attributes.name !== 'string') throw new Error(`Resource requires a name: ${filePath}`);
  return attributes.name;
}

async function assertUniqueAsync(resources: NamedResource[], kind: string): Promise<void> {
  const seen = new Map<string, string>();
  const digestByName = new Map<string, string>();
  for (const resource of resources) {
    const previous = seen.get(resource.name);
    const digest =
      resource.digest ??
      createHash('sha256')
        .update(await fs.promises.readFile(resource.path))
        .digest('hex');
    if (previous && digestByName.get(resource.name) !== digest) {
      throw new Error(`Conflicting ${kind} "${resource.name}": ${previous} and ${resource.path}`);
    }
    seen.set(resource.name, resource.path);
    digestByName.set(resource.name, digest);
  }
}

function dispatcherAgentSource(): string {
  const attributes: JsonObject = {
    name: DISPATCHER_AGENT_NAME,
    description: 'Selects and launches Agiflow workflows for one loop pass without implementing the work.',
    thinking: 'high',
    systemPromptMode: 'replace',
    inheritProjectContext: true,
    inheritSkills: true,
    tools: DISPATCHER_TOOLS.join(', '),
    // No feature extension is named here. Team inherits the ordered child
    // composition projected from the selected layers for every helper process.
    defaultContext: 'fresh',
    defaultProgress: false,
  };
  const body = [
    'You are the Agiflow workflow dispatcher.',
    'Reason about the supplied dispatch context and launch eligible workflows.',
    'Launch workflows without monitoring them. After dispatching, report and exit.',
    'Follow the task restrictions exactly. Do not implement jobs or edit repository files.',
  ].join('\n');
  return `---\n${stringify(attributes).trim()}\n---\n\n${body}\n`;
}

export function mergeMcpConfigs(configPaths: string[]): JsonObject {
  const merged: JsonObject = { mcpServers: {} };
  const servers = merged.mcpServers as Record<string, unknown>;
  const sources = new Map<string, string>();
  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as JsonObject;
    const incoming = (config.mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, definition] of Object.entries(incoming)) {
      const previous = servers[name];
      if (previous && JSON.stringify(previous) !== JSON.stringify(definition)) {
        throw new Error(`Conflicting MCP server "${name}": ${sources.get(name)} and ${configPath}`);
      }
      servers[name] = definition;
      sources.set(name, configPath);
    }
  }
  return merged;
}

export async function mergeMcpConfigsAsync(configPaths: string[]): Promise<JsonObject> {
  const merged: JsonObject = { mcpServers: {} };
  const servers = merged.mcpServers as Record<string, unknown>;
  const sources = new Map<string, string>();
  for (const configPath of configPaths) {
    let content: string;
    try {
      content = await fs.promises.readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const config = JSON.parse(content) as JsonObject;
    const incoming = (config.mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, definition] of Object.entries(incoming)) {
      const previous = servers[name];
      if (previous && JSON.stringify(previous) !== JSON.stringify(definition)) {
        throw new Error(`Conflicting MCP server "${name}": ${sources.get(name)} and ${configPath}`);
      }
      servers[name] = definition;
      sources.set(name, configPath);
    }
  }
  return merged;
}

async function mergeProjectedMcpConfigs(
  sources: readonly DoomMcpProjectionSource[],
  stagingDirectory: string,
): Promise<JsonObject> {
  const merged: JsonObject = { mcpServers: {} };
  const servers = merged.mcpServers as Record<string, unknown>;
  const origins = new Map<string, string>();

  for (const source of sources) {
    let config: JsonObject;
    if (source.format === 'agent-plugin-v1') {
      config = normalizeAgentPluginMcpSource(source, {
        stagingDirectory,
        // The generated file is consumed by external MCP clients. Keep wrapper
        // names there; Doom strips its own in-process wrapper at runtime.
        stripProxyWrappers: false,
      }).claudeConfig;
    } else {
      let content: string;
      try {
        content = await fs.promises.readFile(source.configPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      config = JSON.parse(content) as JsonObject;
    }

    const incoming = (config.mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, definition] of Object.entries(incoming)) {
      const previous = servers[name];
      if (previous && JSON.stringify(previous) !== JSON.stringify(definition)) {
        throw new Error(`Conflicting MCP server "${name}": ${origins.get(name)} and ${source.configPath}`);
      }
      servers[name] = definition;
      origins.set(name, source.configPath);
    }
  }

  return merged;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a resource name against a subset filter. Undefined keeps everything. */
function keepsName(allowed: string[] | undefined, name: string): boolean {
  if (!allowed) return true;
  return allowed.some((pattern) =>
    pattern.includes('*')
      ? new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name)
      : pattern === name,
  );
}

/** Stages only the MCP slice shared by DoomPi and compatibility frontends. */
export async function stageMcpResources(
  repoRoot: string,
  plugins: Array<string | PluginEntry>,
  options: McpResourceOptions,
): Promise<StagedMcpResources> {
  const pluginEntries: PluginEntry[] = plugins.map((plugin) =>
    typeof plugin === 'string' ? { directory: plugin } : plugin,
  );
  const pluginMcpConfigPaths: string[] = [];
  const pluginMcpSources: DoomMcpProjectionSource[] = [];
  const mcpSources: DoomMcpProjectionSource[] = [];
  const pluginDataRoot = options.pluginDataRoot ?? path.join(globalDoomConfigDirectory(), PLUGIN_DATA_DIRECTORY);
  const repositoryMcpPath = path.join(repoRoot, '.mcp.json');

  await fs.promises.mkdir(options.temporaryDirectory, { mode: 0o700, recursive: true });
  await fs.promises.chmod(options.temporaryDirectory, 0o700);
  if (options.enabled && (await pathExists(repositoryMcpPath))) {
    const content = await fs.promises.readFile(repositoryMcpPath);
    mcpSources.push({
      sourceId: 'repository:.mcp.json',
      owner: 'repository',
      format: 'native',
      configPath: repositoryMcpPath,
      contentDigest: createHash('sha256').update(content).digest('hex'),
    });
  }

  if (options.enabled) {
    for (const entry of pluginEntries) {
      const source = await pluginMcpSource(entry, pluginDataRoot);
      if (!source) continue;
      mcpSources.push(source);
      pluginMcpSources.push(source);
      pluginMcpConfigPaths.push(source.configPath);
    }
  }

  let mcpConfigPath: string | undefined;
  if (options.enabled) {
    mcpConfigPath = path.join(options.temporaryDirectory, 'mcp.json');
    const merged = await applyMcpAllowlist(
      await mergeProjectedMcpConfigs(mcpSources, options.temporaryDirectory),
      options.mcpAllowlist,
      repoRoot,
      options.temporaryDirectory,
    );
    await fs.promises.writeFile(mcpConfigPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  }

  const projectionWithoutRuntimePath = {
    version: DOOM_MCP_PROJECTION_VERSION,
    enabled: options.enabled,
    repoRoot,
    ...(mcpConfigPath ? { generatedConfigPath: mcpConfigPath } : {}),
    sources: options.enabled ? mcpSources : [],
    ...(options.mcpAllowlist ? { allowlist: structuredClone(options.mcpAllowlist) } : {}),
  } satisfies Omit<DoomMcpProjection, 'fingerprint' | 'stagingDirectory'>;

  return {
    mcpConfigPath,
    mcpProjection: {
      ...projectionWithoutRuntimePath,
      stagingDirectory: options.temporaryDirectory,
      fingerprint: projectionFingerprint(projectionWithoutRuntimePath),
    },
    pluginMcpSources,
    pluginMcpConfigPaths,
  };
}

/**
 * Stages every resource the selected domains contribute, ready for one Pi session.
 *
 * The caller owns the returned cleanup(): the temporary directory holding agents
 * and the generated MCP config has to outlive this function and be removed once
 * the session that reads it is done.
 */
export async function collectResources(
  repoRoot: string,
  plugins: Array<string | PluginEntry>,
  options: HarnessResourceOptions,
): Promise<HarnessResources> {
  const pluginEntries: PluginEntry[] = plugins.map((plugin) =>
    typeof plugin === 'string' ? { directory: plugin } : plugin,
  );
  // A caller-supplied directory is owned by the caller: it is either a live
  // session's directory or the synced one, and removing it here would delete
  // resources that outlive this collection.
  const ownsDirectory = options.temporaryDirectory === undefined;
  const temporaryDirectory =
    options.temporaryDirectory ?? (await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doom-pi-')));
  await fs.promises.mkdir(temporaryDirectory, { mode: 0o700, recursive: true });
  await fs.promises.chmod(temporaryDirectory, 0o700);
  const sharedSkills = path.join(repoRoot, '.claude', 'skills');
  // A domain can opt out of the always-on shared skills to keep its context small.
  const sharedSkillSources =
    options.sharedSkills === false
      ? []
      : await discoverSkillsAsync(repoRoot, sharedSkills, 'recursive', options.skillCacheDirectory);
  const skillDirectories: string[] = [];
  const skillSources: NamedResource[] = [];
  const agentSources: Array<{ name: string; path: string }> = [];
  const pluginHooks: PluginHookSource[] = [];

  for (const entry of pluginEntries) {
    const pluginDirectory = entry.directory;
    const skills = path.join(pluginDirectory, 'skills');
    if (await pathExists(skills)) {
      const found = (
        await discoverSkillsAsync(repoRoot, skills, entry.skillDiscovery ?? 'recursive', options.skillCacheDirectory)
      ).filter((skill) => keepsName(entry.skills, skill.name));
      // Exact files let Pi skip another recursive traversal and make a plugin
      // subset unambiguous without staging copies of the skill bodies.
      skillDirectories.push(...found.map((skill) => skill.path));
      skillSources.push(...found);
    }
    const agents = path.join(pluginDirectory, 'agents');
    const agentFiles = await markdownFilesAsync(agents);
    const agentNames = await Promise.all(agentFiles.map((filePath) => frontmatterNameAsync(filePath)));
    agentSources.push(
      ...agentFiles
        .map((filePath, index) => ({ name: agentNames[index] ?? '', path: filePath }))
        .filter((agent) => keepsName(entry.agents, agent.name)),
    );
    const hookConfig = path.join(pluginDirectory, 'hooks', 'hooks.json');
    if (entry.hooks !== false && (await pathExists(hookConfig))) {
      pluginHooks.push({ pluginRoot: pluginDirectory, configPath: hookConfig });
    }
  }

  await assertUniqueAsync(skillSources, 'skill');
  await assertUniqueAsync(sharedSkillSources, 'skill');
  // Pi keeps the first skill for a duplicated name. Selected domain plugins are
  // authoritative; shared Claude skills remain fallbacks for names no plugin owns.
  const pluginSkillNames = new Set(skillSources.map((skill) => skill.name));
  const fallbackSharedSkills = sharedSkillSources.filter((skill) => !pluginSkillNames.has(skill.name));
  skillDirectories.push(...fallbackSharedSkills.map((skill) => skill.path));
  skillSources.push(...fallbackSharedSkills);

  await assertUniqueAsync(agentSources, 'agent');
  if (agentSources.some((source) => source.name === DISPATCHER_AGENT_NAME)) {
    throw new Error(`Conflicting agent "${DISPATCHER_AGENT_NAME}": reserved by the agent harness`);
  }

  const agentDirectories: string[] = [];
  const outputDirectory = path.join(temporaryDirectory, 'agents');
  await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  if (options.agents) {
    await fs.promises.mkdir(outputDirectory, { mode: 0o700 });
    for (const source of agentSources) {
      const adapted = adaptAgentDefinition(await fs.promises.readFile(source.path, 'utf8'));
      await fs.promises.writeFile(
        path.join(outputDirectory, `${assertSafeAgentName(adapted.name)}.md`),
        adapted.content,
        { mode: 0o600 },
      );
    }
    await fs.promises.writeFile(path.join(outputDirectory, `${DISPATCHER_AGENT_NAME}.md`), dispatcherAgentSource(), {
      mode: 0o600,
    });
    agentDirectories.push(outputDirectory);
  }

  const { mcpConfigPath, mcpProjection, pluginMcpSources, pluginMcpConfigPaths } = await stageMcpResources(
    repoRoot,
    pluginEntries,
    {
      enabled: options.mcp,
      temporaryDirectory,
      ...(options.mcpAllowlist ? { mcpAllowlist: options.mcpAllowlist } : {}),
      ...(options.pluginDataRoot ? { pluginDataRoot: options.pluginDataRoot } : {}),
    },
  );

  return {
    temporaryDirectory,
    skillDirectories,
    skillCount: skillSources.length,
    agentCount: agentSources.length,
    agentDirectories,
    pluginHooks,
    mcpConfigPath,
    mcpProjection,
    pluginMcpSources,
    pluginMcpConfigPaths,
    cleanup: () =>
      ownsDirectory ? fs.promises.rm(temporaryDirectory, { recursive: true, force: true }) : Promise.resolve(),
  };
}
