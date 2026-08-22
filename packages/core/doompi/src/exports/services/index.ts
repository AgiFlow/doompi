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
} from '../../adapters/compatibility';
export { buildCompatibilityContext, type CompatibilityContext } from '../../adapters/compatibilityContext';
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
} from '../../adapters/composer';
export {
  buildHarnessContext,
  configurePreset,
  type HarnessContext,
  resolveHarnessProfile,
} from '../../adapters/harnessContext';
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
export { extensionLayers, needsRelaunch } from '../../services/transitionClassifier';
// MinorModeCatalogHost itself now lives in @agimon-ai/doompi-extension-contracts/transition,
// where the packages that consume it can reach it without depending on the host.
export { createMinorModeCatalogHost, type MinorModeCatalogHostOptions } from '../../services/modeCatalog';
export {
  mergePiSettings,
  type PiSettingsUpdate,
  piSettingsPath,
  readPiSettings,
  serializePiSettings,
  writePiSettings,
} from '../../adapters/piSettings';
export {
  DUPLICATE_REGISTRATION_DRIFT,
  mergeProjectPiSettings,
  projectPiSettingsPath,
  projectRegistersDoom,
  readProjectPiSettings,
  serializeProjectPiSettings,
  writeProjectPiSettings,
} from '../../adapters/projectPiSettings';
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
} from '../../adapters/syncState';
