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

export { CliApp, runCli, runHarness } from '../controllers/cliApp';
export { parseCompatibilityArgs, parseCompatibilityProvider } from '../controllers/compatibilityOptions';
// Published so a session server settles the same option matrix the launcher
// does, instead of shelling out to the CLI purely to parse arguments.
export { resolveHarnessOptions, type ResolveHarnessOptionsInput } from '../controllers/harnessOptions';
export { compatHelp, doctorHelp, HARNESS_VERSION, initHelp, printHelp, syncHelp } from '../controllers/help';
export { parseHarnessArgs } from '../controllers/options';
export {
  informationalRequest,
  KNOWN_COMMANDS,
  type KnownCommand,
  routeCommand,
  wantsHelp,
} from '../controllers/router';

/**
 * Commands Exports
 */

export { BaseCommand } from '../controllers/baseCommand';
export { CompatibilityCommand } from '../controllers/compatibilityCommand';
export { DoctorCommand, type DoctorOutput } from '../controllers/doctorCommand';
export { EmitMcpCommand } from '../controllers/emitMcpCommand';
export { ExplainCommand, explainMatrix, type MatrixExplanation } from '../controllers/explainCommand';
export { InitCommand } from '../controllers/initCommand';
export { LaunchCommand } from '../controllers/launchCommand';
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
} from '../controllers/syncCommand';

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
} from '../services/harnessState';
export {
  applyProjectTrust,
  type DoomConfig,
  hasProjectTrustOption,
  loadDoomConfig,
  type ProjectTrust,
} from '../services/projectTrust';

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
} from '../services/compatibility';
export { buildCompatibilityContext, type CompatibilityContext } from '../services/compatibilityContext';
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
} from '../controllers/composer';
export {
  buildHarnessContext,
  configurePreset,
  type HarnessContext,
  resolveHarnessProfile,
} from '../services/harnessContext';
// The launch plan and the layer installer are published so a session server can
// run the same preparation the launcher does without spawning the CLI to do it.
export { ensureLayerPackages, type EnsureLayerPackagesOptions } from '../services/layerPackageInstaller';
// Drift detection, so a host can tell whether a session it is about to start
// would run against artifacts sync has not produced yet.
export {
  describeSyncDrift,
  readSyncDrift,
  type ReadSyncDriftOptions,
  type SyncDrift,
  type SyncDriftReason,
} from '../services/syncDrift';
export { readSyncRegistration, type SyncRegistration } from '../services/syncRegistration';
export {
  ensureElicitationSessionId,
  overridePiThemes,
  type PiLaunchPlan,
  resolveLaunchPlan,
} from '../services/launchPlan';
export { LAUNCHER_COMPOSITION_ENV, LAUNCHER_COMPOSITION_REQUEST_ENV } from '../constants/launcherComposition';
export {
  buildRuntimeBundle,
  createRuntimeExtensionPlan,
  type RuntimeBundleBuild,
  type RuntimeExtensionPlan,
} from '../services/runtimeBundle';
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
export { extensionLayers, needsRelaunch } from '../services/transitionClassifier';
// MinorModeCatalogHost itself now lives in @agimon-ai/doompi-extension-contracts/transition,
// where the packages that consume it can reach it without depending on the host.
export { createMinorModeCatalogHost, type MinorModeCatalogHostOptions } from '../services/modeCatalog';
export {
  mergePiSettings,
  type PiSettingsUpdate,
  piSettingsPath,
  readPiSettings,
  serializePiSettings,
  writePiSettings,
} from '../services/piSettings';
export {
  DUPLICATE_REGISTRATION_DRIFT,
  mergeProjectPiSettings,
  projectPiSettingsPath,
  projectRegistersDoom,
  readProjectPiSettings,
  serializeProjectPiSettings,
  writeProjectPiSettings,
} from '../services/projectPiSettings';
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
} from '../services/syncState';

// Interfaces - TypeScript contracts and types
export type {
  CompatibilityOptions,
  CompatibilityProvider,
  ParsedCompatibilityArgs,
} from '../types/interfaces/compatibility';
export type {
  HarnessOptions,
  HarnessOutputFormat,
  HarnessPreset,
  ParsedHarnessArgs,
} from '../types/interfaces/harness';
export type { PluginHookSource } from '@agimon-ai/doompi-config/types';
export type { HarnessResourceOptions, HarnessResources } from '@agimon-ai/doompi-domain/resources';
// Utilities - module and repository resolution
/**
 * Utility Exports
 */

export {
  consumerPackageEntries,
  consumerPackageEntry,
  localEntries,
  localEntry,
  localPackageEntries,
  localPackageName,
  optionalPackageEntries,
  optionalPackageEntry,
  ownEntry,
  packageEntries,
  packageEntry,
  piCliPath,
  splitPackageSpecifier,
} from '../services/moduleResolution';
export { findRepositoryRoot, isRepositoryRoot } from '../services/repository';
export { canonicalModulePath, sha256 } from '../services/runtimeIdentity';
export { isRecord, type JsonObject, readJson, writeFileAtomic, writeJson } from '../services/json';
export { toClaudeToolName, toPiToolName } from '../services/toolNames';
