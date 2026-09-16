export interface LocalPluginSource {
  type: 'local';
  /** Absolute plugin directory after resolving the declaring config or marketplace root. */
  path: string;
}

export interface GitPluginSource {
  type: 'git';
  url: string;
  /** Optional repository-relative plugin directory. */
  path?: string;
  ref?: string;
  sha?: string;
}

export interface NpmPluginSource {
  type: 'npm';
  package: string;
  version?: string;
  registry?: string;
}

export type PluginSource = LocalPluginSource | GitPluginSource | NpmPluginSource;
export type PluginSkillDiscovery = 'recursive' | 'direct-children';

export interface PluginManifestMetadata {
  path: string;
  name?: string;
  version?: string;
  description?: string;
  agentPluginSchema?: string;
}

export interface PluginCatalogEntry {
  source: PluginSource;
  description?: string;
  marketplace?: string;
  manifest?: PluginManifestMetadata;
}

export interface PluginCatalog {
  /** Marketplace, plugin, or plugin-container roots resolved against their declaring config. */
  roots: string[];
  /** Supported marketplace manifests discovered in precedence order. */
  marketplaces: string[];
  /** Named explicit and marketplace plugin entries. */
  entries: Record<string, PluginCatalogEntry>;
  /** Non-fatal errors from automatic marketplace and folder discovery. */
  diagnostics: string[];
}

/** A named plugin, or a subset of one. */
export type DomainPlugin =
  | string
  | { name: string; skills?: string[]; agents?: string[]; hooks?: boolean; mcp?: boolean };

export interface DomainMcpAllowlist {
  /** Server names kept from the repository-level .mcp.json. */
  servers?: string[];
  /** Upstream server names kept in the agiflow-proxy config. */
  proxy?: string[];
}

export interface DomainDefinition {
  description?: string;
  plugins?: DomainPlugin[];
  mcp?: DomainMcpAllowlist;
  sharedSkills?: boolean;
}

export interface ResolvedDomain extends DomainDefinition {
  baseDirectory: string;
}

export interface DomainManifest {
  plugins: PluginCatalog;
  domains: Record<string, ResolvedDomain>;
  aliases: Record<string, string[]>;
  defaultDomains?: string[];
}

export interface PluginEntry {
  /** Catalog identifier when the entry came from domains.yaml. */
  name?: string;
  directory: string;
  /** The domain that admitted this plugin; absent for an explicit directory. */
  domain?: string;
  /** Omitted for legacy programmatic callers that already supply a directory. */
  source?: PluginSource;
  /** Manifest metadata retained so resource adapters can apply schema-gated plugin contracts. */
  manifest?: PluginManifestMetadata;
  skillDiscovery?: PluginSkillDiscovery;
  skills?: string[];
  agents?: string[];
  hooks?: boolean;
  mcp?: boolean;
}
