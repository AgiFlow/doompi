/**
 * Configuration for `.doom`, plus the resolved process state.
 *
 * Profiles (persona and env), layers (behavior), domains (content), and the default theme are loaded from
 * disk per run. harnessState is the other direction: the already-resolved
 * matrix as the child process reads it back out of the environment.
 */

export {
  DOOM_DIR,
  type DomainDefinition,
  type DomainManifest,
  type DomainMcpAllowlist,
  type DomainPlugin,
  domainCompletionItems,
  domainCompletionPrefix,
  listDomainNames,
  loadDomains,
  type PluginEntry,
  resolvePluginDirectories,
  resolvePluginEntries,
  resolveSharedSkills,
} from '@agimon-ai/doompi-config/domains';
export {
  type LayerDefinition,
  type LayerPackage,
  type LayerPackageConfig,
  type LayerResolvers,
  layerEntries,
  layerHookGroups,
  loadMajorModesConfig,
  type MajorModesConfig,
  type ResolvedPackageConfiguration,
  resolveLayers,
  resolvePackageConfigurations,
} from '@agimon-ai/doompi-config/majorModes';
export {
  type AgentProfile,
  applyProfileEnvironment,
  buildPersonaPrompt,
  listProfileNames,
  loadProfiles,
  PERSONA_FILES,
  replaceProfileEnvironment,
  resolveProfile,
} from '@agimon-ai/doompi-config/profiles';
export { DEFAULT_THEME, DEFAULT_THEME_NAME, writeDefaultTheme } from '@agimon-ai/doompi-ui/theme';
export {
  createHarnessSession,
  getHarnessState,
  HARNESS_STATE_KEYS,
  HARNESS_STATE_POINTER,
  type HarnessState,
  harnessRoot,
  loadHarnessState,
  projectHarnessEnvironment,
  readHarnessState,
  refreshHarnessState,
  requireHarnessPaths,
  requireHarnessRoot,
  resetHarnessStore,
  updateHarnessState,
} from '../../adapters/config/harnessState';
export {
  applyProjectTrust,
  type DoomConfig,
  hasProjectTrustOption,
  loadDoomConfig,
  type ProjectTrust,
} from '../../services/config/projectTrust';
