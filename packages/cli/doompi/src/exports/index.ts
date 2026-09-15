/**
 * @agimon-ai/doompi
 *
 * doom-pi is an opinionated, context light, lazy config agent inspired by doom
 * emacs.
 *
 * DESIGN PRINCIPLES:
 * - Barrel exports for a clean API surface
 * - Explicit public API definition
 * - Executable Pi entries are published separately under extensions.
 */

// CLI Core - application, argument parsing, and the command framework
/**
 * CLI Application Exports
 */

export { CliApp, runCli, runHarness } from '../cli/cliApp';
export { parseCompatibilityArgs, parseCompatibilityProvider } from '../cli/commands/compat/options';
// Published so a session server settles the same option matrix the launcher
// does, instead of shelling out to the CLI purely to parse arguments.
export { resolveHarnessOptions, type ResolveHarnessOptionsInput } from '../cli/harnessOptions';
export { compatHelp, doctorHelp, HARNESS_VERSION, initHelp, printHelp, syncHelp } from '../cli/help';
export { parseHarnessArgs } from '../cli/options';
export { informationalRequest, KNOWN_COMMANDS, type KnownCommand, routeCommand, wantsHelp } from '../cli/router';

/**
 * Commands Exports
 */

export { BaseCommand } from '../cli/commands/baseCommand';
export { CompatibilityCommand } from '../cli/commands/compat';
export { DoctorCommand, type DoctorOutput } from '../cli/commands/doctor';
export { EmitMcpCommand } from '../cli/commands/emit-mcp';
export { ExplainCommand, explainMatrix, type MatrixExplanation } from '../cli/commands/explain';
export { InitCommand } from '../cli/commands/init';
export { LaunchCommand } from '../cli/commands/launch';
export {
  collectDrift,
  formatSyncResult,
  recordedEnvironment,
  SyncCommand,
  type SyncCommandOptions,
  type SyncResult,
  type SyncSettingsMode,
  selectionEnvironment,
  toSelection,
} from '../cli/commands/sync';

// Configuration - the .doom mode, profile, and theme surfaces
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
} from '../composition/harnessState';
export {
  applyProjectTrust,
  type DoomConfig,
  hasProjectTrustOption,
  loadDoomConfig,
  type ProjectTrust,
} from '../composition/projectTrust';

// Services - matrix resolution and session composition
/**
 * Services Exports
 */

export {
  adaptAntigravityMcpDefinition,
  antigravityCompatibilityArgs,
  claudeCompatibilityArgs,
  codexCompatibilityArgs,
  launchCompatibility,
  runInteractive,
  signalExitCode,
  supportsCodexManagedProfile,
} from '../cli/commands/compat/providers';
export { buildCompatibilityContext, type CompatibilityContext } from '../cli/commands/compat/context';
export {
  alreadyComposed,
  COMPOSED_ENV,
  type ComposeOutcome,
  cleanupRunDirectory,
  composeDoomSession,
  composeLoadOrder,
  DOOM_FLAGS,
  extensionsProvidedExternally,
  findSyncedRoot,
  loadComposedExtensions,
  MUTE_ENV,
  prepareRunDirectory,
  readStartupFlags,
  registerDoomFlags,
  type StartupFlags,
  startSyncedSession,
} from '../builders/cli/composition';
export {
  buildHarnessContext,
  configurePreset,
  type HarnessContext,
  resolveHarnessProfile,
} from '../builders/cli/harnessContext';
// The launch plan and the layer installer are published so a session server can
// run the same preparation the launcher does without spawning the CLI to do it.
export { ensureLayerPackages, type EnsureLayerPackagesOptions } from '../composition/layerPackageInstaller';
// Drift detection, so a host can tell whether a session it is about to start
// would run against artifacts sync has not produced yet.
export {
  describeSyncDrift,
  readSyncDrift,
  type ReadSyncDriftOptions,
  type SyncDrift,
  type SyncDriftReason,
} from '../composition/syncDrift';
export {
  ensureElicitationSessionId,
  overridePiThemes,
  type PiLaunchPlan,
  resolveLaunchPlan,
} from '../builders/cli/launchPlan';
export { LAUNCHER_COMPOSITION_ENV, LAUNCHER_COMPOSITION_REQUEST_ENV } from '../builders/cli/constants';
export {
  buildRuntimeBundle,
  createRuntimeExtensionPlan,
  type RuntimeBundleBuild,
  type RuntimeExtensionPlan,
} from '../builders/cli/runtimeBundle';
// applyMajorMode, applyPersona and applyProfile are published by
// @agimon-ai/doompi-config/selectionSwitch, while domain staging is published
// by @agimon-ai/doompi-domain. These re-exports preserve the host's public API.
export { applyDomains } from '@agimon-ai/doompi-domain/apply';
export {
  applyMcpAllowlist,
  filterMcpServers,
  filterProxyConfig,
  persistMcpConfig,
  PROXY_SERVER_NAME,
  resolveMcpAllowlist,
} from '@agimon-ai/doompi-domain/mcp';
// MinorModeCatalogHost itself now lives in @agimon-ai/doompi-core/transition,
// where the packages that consume it can reach it without depending on the host.
export { createMinorModeCatalogHost, type MinorModeCatalogHostOptions } from '@agimon-ai/doompi-minor-mode/catalog';
export {
  DUPLICATE_REGISTRATION_DRIFT,
  mergeProjectPiSettings,
  projectPiSettingsPath,
  projectRegistersDoom,
  readProjectPiSettings,
  serializeProjectPiSettings,
  writeProjectPiSettings,
} from '../builders/cli/projectSettings';
export {
  adaptAgentDefinition,
  collectResources,
  DISPATCHER_AGENT_NAME,
  mergeMcpConfigs,
} from '@agimon-ai/doompi-domain/resources';
export {
  computeInputsHash,
  createMapResolvers,
  createRecordingResolvers,
  readMcpServerNames,
  readSyncState,
  recordResolvedEntries,
  runDirectory,
  type SyncBaseline,
  type SyncSelection,
  type SyncState,
  serializeSyncState,
  settingsRelativePath,
  syncDirectory,
  syncStatePath,
  writeSyncState,
} from '../composition/syncState';

// Interfaces - TypeScript contracts and types
export type {
  CompatibilityOptions,
  CompatibilityProvider,
  ParsedCompatibilityArgs,
} from '../cli/commands/compat/types';
export type {
  HarnessOptions,
  HarnessOutputFormat,
  HarnessPreset,
  ParsedHarnessArgs,
} from '../composition/types/harness';
export type { PluginHookSource } from '@agimon-ai/doompi-config/types';
export type { HarnessResourceOptions, HarnessResources } from '@agimon-ai/doompi-domain/resources';
// Utilities - module and repository resolution
/**
 * Utility Exports
 */

export { findRepositoryRoot, isRepositoryRoot } from '../composition/repository';
