export {
  DEFAULT_DOMAIN,
  DOOMPI_DOMAINS_ENV,
  DOOM_DIR,
  defaultDomainsForMajorMode,
  listDomainNames,
  loadDomains,
  resolvePluginDirectories,
  resolvePluginEntries,
  resolveSharedSkills,
} from '../services/domains';
export { domainCompletionItems, domainCompletionPrefix, expandDomainNames } from '../services/domains/completion';
export {
  MARKETPLACE_MANIFEST_RELATIVE_PATHS,
  findPluginManifestPath,
  isRemotePluginSource,
  pluginDirectoryForSource,
} from '../services/pluginCatalog';
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
} from '../types/domains';
