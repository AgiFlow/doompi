export {
  DEFAULT_DOMAIN,
  defaultDomainsForMajorMode,
  DOOM_DIR,
  DOOMPI_DOMAINS_ENV,
  listDomainNames,
  loadDomains,
  resolvePluginDirectories,
  resolvePluginEntries,
  resolveSharedSkills,
} from '../adapters/domains.ts';
export {
  findPluginManifestPath,
  isRemotePluginSource,
  MARKETPLACE_MANIFEST_RELATIVE_PATHS,
  pluginDirectoryForSource,
} from '../adapters/pluginCatalog.ts';
export { domainCompletionItems, domainCompletionPrefix, expandDomainNames } from '../services/domains.ts';
export type {
  DomainDefinition,
  DomainManifest,
  DomainMcpAllowlist,
  DomainPlugin,
  GitPluginSource,
  LocalPluginSource,
  NpmPluginSource,
  PluginCatalog,
  PluginCatalogEntry,
  PluginEntry,
  PluginManifestMetadata,
  PluginSkillDiscovery,
  PluginSource,
  ResolvedDomain,
} from '../types/domains.ts';
