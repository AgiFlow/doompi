import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandDomainNames } from '../services/domains.ts';
import type {
  DomainDefinition,
  DomainManifest,
  DomainMcpAllowlist,
  DomainPlugin,
  PluginEntry,
  ResolvedDomain,
} from '../types/domains.ts';
import { globalDoomConfigDirectory } from './config.ts';
import { readDoomConfigSources } from './layeredConfig.ts';
import { loadPluginCatalog, pluginDirectoryForSource } from './pluginCatalog.ts';

export { DOOM_DIR } from './layeredConfig.ts';

const DOMAINS_FILE = 'domains.yaml';
const UNKNOWN_DOMAIN_ERROR = 'Unknown domain';
const UNKNOWN_PLUGIN_ERROR = 'Unknown plugin';
const MISSING_PLUGIN_DIRECTORY_ERROR = 'Plugin directory does not exist';
const DEFAULT_DOMAINS_PATH = '.doom/domains.yaml';
const SUPPORTED_AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field "${unexpected[0]}"`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of non-empty strings`);
  return [...new Set(value.map((entry, index) => requireString(entry, `${label}[${index}]`)))];
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function parseDefaultDomains(value: unknown): string[] {
  return parseStringArray(value, `defaultDomains in ${DEFAULT_DOMAINS_PATH}`);
}

function parseDomainPlugin(value: unknown, label: string): DomainPlugin {
  if (typeof value === 'string') return requireString(value, label);
  const plugin = requireRecord(value, label);
  assertOnlyKeys(plugin, ['name', 'skills', 'agents', 'hooks', 'mcp'], label);
  const skills = plugin.skills === undefined ? undefined : parseStringArray(plugin.skills, `${label}.skills`);
  const agents = plugin.agents === undefined ? undefined : parseStringArray(plugin.agents, `${label}.agents`);
  const hooks = parseOptionalBoolean(plugin.hooks, `${label}.hooks`);
  const mcp = parseOptionalBoolean(plugin.mcp, `${label}.mcp`);
  return {
    name: requireString(plugin.name, `${label}.name`),
    ...(skills ? { skills } : {}),
    ...(agents ? { agents } : {}),
    ...(hooks === undefined ? {} : { hooks }),
    ...(mcp === undefined ? {} : { mcp }),
  };
}

function parseMcpAllowlist(value: unknown, label: string): DomainMcpAllowlist {
  const mcp = requireRecord(value, label);
  assertOnlyKeys(mcp, ['servers', 'proxy'], label);
  return {
    ...(mcp.servers === undefined ? {} : { servers: parseStringArray(mcp.servers, `${label}.servers`) }),
    ...(mcp.proxy === undefined ? {} : { proxy: parseStringArray(mcp.proxy, `${label}.proxy`) }),
  };
}

function parseDomain(value: unknown, label: string): DomainDefinition {
  const domain = requireRecord(value, label);
  assertOnlyKeys(domain, ['description', 'plugins', 'mcp', 'sharedSkills'], label);
  const description = optionalString(domain.description, `${label}.description`);
  if (domain.plugins !== undefined && !Array.isArray(domain.plugins)) {
    throw new Error(`${label}.plugins must be an array`);
  }
  const sharedSkills = parseOptionalBoolean(domain.sharedSkills, `${label}.sharedSkills`);
  return {
    ...(description ? { description } : {}),
    ...(Array.isArray(domain.plugins)
      ? { plugins: domain.plugins.map((plugin, index) => parseDomainPlugin(plugin, `${label}.plugins[${index}]`)) }
      : {}),
    ...(domain.mcp === undefined ? {} : { mcp: parseMcpAllowlist(domain.mcp, `${label}.mcp`) }),
    ...(sharedSkills === undefined ? {} : { sharedSkills }),
  };
}

function parseAliases(value: unknown, label: string): Record<string, string[]> {
  if (value === undefined) return {};
  const aliases = requireRecord(value, label);
  return Object.fromEntries(
    Object.entries(aliases).map(([name, domains]) => [name, parseStringArray(domains, `${label}.${name}`)]),
  );
}

/**
 * Reads domains and plugin catalogs from global and repository configs.
 *
 * Named domains and explicit plugin entries are replaced by later repository
 * definitions. Configured roots accumulate, with exact marketplace manifests
 * deduplicated in discovery order. Explicit entries override discovered IDs.
 */
export function loadDomains(repoRoot: string, homeDirectory: string = os.homedir()): DomainManifest {
  const sources = readDoomConfigSources<unknown>(DOMAINS_FILE, repoRoot, homeDirectory);
  const aliases: Record<string, string[]> = {};
  const domains: Record<string, ResolvedDomain> = {};
  let defaultDomains: string[] | undefined;

  for (const source of sources) {
    const document = requireRecord(source.document, source.filePath);
    assertOnlyKeys(document, ['plugins', 'domains', 'aliases', 'defaultDomains'], source.filePath);
    Object.assign(aliases, parseAliases(document.aliases, `aliases in ${source.filePath}`));
    if (document.domains !== undefined) {
      const sourceDomains = requireRecord(document.domains, `domains in ${source.filePath}`);
      for (const [name, definition] of Object.entries(sourceDomains)) {
        domains[name] = {
          ...parseDomain(definition, `domains.${name} in ${source.filePath}`),
          baseDirectory: source.baseDirectory,
        };
      }
    }
    if (Object.hasOwn(document, 'defaultDomains')) defaultDomains = parseDefaultDomains(document.defaultDomains);
  }

  const plugins = loadPluginCatalog(
    sources.map((source) => ({
      filePath: source.filePath,
      baseDirectory: source.baseDirectory,
      value: requireRecord(source.document, source.filePath).plugins,
    })),
    repoRoot,
    homeDirectory,
  );

  if (defaultDomains) {
    for (const name of expandDomainNames({ plugins, domains, aliases }, defaultDomains)) {
      if (!Object.hasOwn(domains, name)) {
        throw new Error(`Unknown default domain "${name}" in ${DEFAULT_DOMAINS_PATH}`);
      }
    }
  }
  return { plugins, domains, aliases, ...(defaultDomains ? { defaultDomains } : {}) };
}

export function listDomainNames(repoRoot: string, homeDirectory?: string): string[] {
  const manifest = loadDomains(repoRoot, homeDirectory);
  return [...new Set([...Object.keys(manifest.domains), ...Object.keys(manifest.aliases)])].sort();
}

/**
 * Whether to include .claude/skills as shared fallbacks.
 *
 * Shared skills are included unless every selected domain opts out, so mixing a
 * trimmed domain with an untrimmed one cannot strip the untrimmed one's skills.
 */
export function resolveSharedSkills(repoRoot: string, domainNames: string[], homeDirectory?: string): boolean {
  const manifest = loadDomains(repoRoot, homeDirectory);
  const expanded = expandDomainNames(manifest, domainNames);
  if (expanded.length === 0) return true;
  return expanded.some((name) => manifest.domains[name]?.sharedSkills !== false);
}

/** Resolves named domain plugins while preserving each subset filter. */
export function resolvePluginEntries(
  repoRoot: string,
  domainNames: string[],
  explicitDirectories: string[],
  homeDirectory: string = os.homedir(),
): PluginEntry[] {
  const manifest = loadDomains(repoRoot, homeDirectory);
  const entries: PluginEntry[] = [];
  const seen = new Set<string>();
  const homeDoomDirectory = globalDoomConfigDirectory(homeDirectory);

  for (const domainName of expandDomainNames(manifest, domainNames)) {
    const domain = manifest.domains[domainName];
    if (!domain) throw new Error(`${UNKNOWN_DOMAIN_ERROR}: ${domainName}`);
    for (const selection of domain.plugins ?? []) {
      const isSubset = typeof selection !== 'string';
      const pluginName = isSubset ? selection.name : selection;
      const plugin = manifest.plugins.entries[pluginName];
      if (!plugin) throw new Error(`${UNKNOWN_PLUGIN_ERROR} "${pluginName}" referenced by domain "${domainName}"`);
      const directory = pluginDirectoryForSource(plugin.source, homeDoomDirectory);
      if (plugin.source.type === 'local' && (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) {
        throw new Error(`${MISSING_PLUGIN_DIRECTORY_ERROR}: ${directory}`);
      }
      if (seen.has(directory)) continue;
      seen.add(directory);
      entries.push({
        name: pluginName,
        directory,
        source: plugin.source,
        ...(plugin.manifest ? { manifest: plugin.manifest } : {}),
        ...(plugin.manifest?.agentPluginSchema === SUPPORTED_AGENT_PLUGIN_SCHEMA
          ? { skillDiscovery: 'direct-children' as const }
          : {}),
        ...(isSubset && selection.skills ? { skills: selection.skills } : {}),
        ...(isSubset && selection.agents ? { agents: selection.agents } : {}),
        ...(isSubset && selection.hooks !== undefined ? { hooks: selection.hooks } : {}),
        ...(isSubset && selection.mcp !== undefined ? { mcp: selection.mcp } : {}),
      });
    }
  }

  for (const configuredDirectory of explicitDirectories) {
    const directory = path.resolve(configuredDirectory);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`${MISSING_PLUGIN_DIRECTORY_ERROR}: ${directory}`);
    }
    if (seen.has(directory)) continue;
    seen.add(directory);
    entries.push({
      name: path.basename(directory),
      directory,
      source: { type: 'local', path: directory },
    });
  }
  return entries;
}

export function resolvePluginDirectories(
  repoRoot: string,
  domainNames: string[],
  explicitDirectories: string[],
  homeDirectory?: string,
): string[] {
  return resolvePluginEntries(repoRoot, domainNames, explicitDirectories, homeDirectory).map(
    (entry) => entry.directory,
  );
}

export const DOOMPI_DOMAINS_ENV = 'DOOMPI_DOMAINS';
export const DEFAULT_DOMAIN = 'default';
const MARKETING_MAJOR_MODE = 'marketing';

function parseDomainList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Domains selected when the caller names none.
 *
 * Configuration keeps this axis independent of the major mode. The
 * major-mode-derived choice is retained only as the compatibility fallback for
 * domains files that declare no defaultDomains.
 */
export function defaultDomainsForMajorMode(
  majorMode: string,
  environment: NodeJS.ProcessEnv,
  defaultDomains?: readonly string[],
): string[] {
  const inherited = environment[DOOMPI_DOMAINS_ENV];
  // An explicitly empty variable means no domains, so this tests for the key
  // rather than for a truthy value.
  if (inherited !== undefined) return parseDomainList(inherited);
  if (defaultDomains !== undefined) return [...defaultDomains];
  return parseDomainList(majorMode === MARKETING_MAJOR_MODE ? MARKETING_MAJOR_MODE : DEFAULT_DOMAIN);
}
