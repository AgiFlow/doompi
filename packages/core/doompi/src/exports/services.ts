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
// Minor-mode catalog ownership belongs to the minor-mode package.
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
