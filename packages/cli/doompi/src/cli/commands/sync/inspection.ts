import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filterHookDisabledLayers, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import {
  mergePiSettings,
  piAgentDirectory,
  piThemeDirectory,
  readPiSettings,
  serializePiSettings,
} from '@agimon-ai/doompi-core/runtimePiSettings';
import { readSyncRegistration, SYNC_REGISTRATION_VERSION } from '@agimon-ai/doompi-core/syncRegistration';
import { DEFAULT_THEME, DEFAULT_THEME_NAME } from '@agimon-ai/doompi-ui/theme';

import { readBootstrapStatus } from '../../../builders/cli/bootstrapLocator';
import {
  createLayerResolvers,
  PERSONA_ENTRY,
  resolveExtensionComposition,
} from '../../../builders/cli/extensionAssembler';
import { piExtensionAliasIsCurrent } from '../../../builders/cli/piExtensionAlias';
import { DUPLICATE_REGISTRATION_DRIFT, projectRegistersDoom } from '../../../builders/cli/projectSettings';
import { loadDoomConfigLenient } from '../../../composition/projectTrust';
import { readSyncDrift, type SyncDriftReason } from '../../../composition/syncDrift';
import {
  computeInputsHash,
  recordResolvedEntries,
  syncStateRootMatches,
  type SyncSelection,
  type SyncState,
} from '../../../composition/syncState';
import type { HarnessOptions } from '../../../composition/types/harness';
import { DOOMPI_DOMAINS_ENV, DOOMPI_MAJOR_MODE_ENV, DOOMPI_PROFILE_ENV } from '../../matrixOptions';

export type SyncSettingsMode = 'persisted' | 'embedded';

/** Read-only checks shared by sync, doctor, and the running agent. No build-time imports. */
export function selectionEnvironment(
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string,
): NodeJS.ProcessEnv {
  const { selection } = loadDoomConfigLenient(repoRoot, homeDirectory).config;
  if (!selection) return environment;
  return {
    ...environment,
    ...(selection.majorMode && !environment[DOOMPI_MAJOR_MODE_ENV]
      ? { [DOOMPI_MAJOR_MODE_ENV]: selection.majorMode }
      : {}),
    ...(selection.profile && !environment[DOOMPI_PROFILE_ENV] ? { [DOOMPI_PROFILE_ENV]: selection.profile } : {}),
    ...(selection.domains && environment[DOOMPI_DOMAINS_ENV] === undefined
      ? { [DOOMPI_DOMAINS_ENV]: selection.domains.join(',') }
      : {}),
  };
}

export function toSelection(
  options: Pick<HarnessOptions, 'majorMode' | 'domains' | 'profile' | 'preset'>,
): SyncSelection {
  return {
    majorMode: options.majorMode,
    domains: options.domains,
    profile: options.profile,
    preset: options.preset,
  };
}

export function selectionCompositionFingerprint(
  repoRoot: string,
  options: Pick<HarnessOptions, 'agents' | 'hooks' | 'majorMode' | 'mcp' | 'preset'>,
  homeDirectory: string = os.homedir(),
): string {
  const majorModesConfig = loadMajorModesConfig(repoRoot, homeDirectory);
  const resolvers = createLayerResolvers(repoRoot);
  return resolveExtensionComposition({
    agents: options.agents,
    autoStop: false,
    mute: false,
    preset: options.preset,
    personaEntry: resolvers.packageEntry(PERSONA_ENTRY),
    majorMode: options.majorMode,
    layers: filterHookDisabledLayers(
      majorModesConfig,
      resolveLayers(majorModesConfig, options.majorMode),
      options.hooks,
    ),
    majorModesConfig,
    resolvers,
  }).fingerprint;
}

/** Settings, dispatcher and theme differences an init would fix, independent of sync state. */
export function piIntegrationDrift(agentDirectory: string): string[] {
  const drift: string[] = [];
  const themePath = path.join(piThemeDirectory(agentDirectory), `${DEFAULT_THEME_NAME}.json`);
  const settings = readPiSettings(agentDirectory);
  const merged = mergePiSettings(settings, agentDirectory, { themePath, themeName: DEFAULT_THEME_NAME });
  if (serializePiSettings(merged) !== serializePiSettings(settings)) {
    drift.push('Pi user settings are out of date; run doompi init');
  }
  if (!piExtensionAliasIsCurrent(agentDirectory)) drift.push('Pi user dispatcher is out of date; run doompi init');
  const expectedTheme = `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`;
  if (!fs.existsSync(themePath) || fs.readFileSync(themePath, 'utf8') !== expectedTheme) {
    drift.push('Pi user theme is out of date; run doompi init');
  }
  return drift;
}

/** Differences between what a sync would produce and what is on disk. */
export function collectDrift(
  repoRoot: string,
  selection: SyncSelection,
  state: SyncState | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  settingsMode: SyncSettingsMode = 'persisted',
  expectedCompositionFingerprint?: string,
): string[] {
  if (!state) return ['no sync state: run doompi sync'];
  const drift: string[] = [];
  if (syncRegistrationNeedsApiMigration(repoRoot, environment.HOME ?? os.homedir())) {
    drift.push('DoomPi registration needs API migration');
  }
  if (!syncStateRootMatches(repoRoot, state.root)) drift.push('sync state belongs to a different repository');
  const recorded = state.selection;
  if (
    recorded.majorMode !== selection.majorMode ||
    recorded.profile !== selection.profile ||
    recorded.preset !== selection.preset ||
    recorded.domains.join(',') !== selection.domains.join(',')
  ) {
    drift.push('selection changed since the last sync');
  }
  // Hash the recorded selection so selection changes are not counted twice.
  if (computeInputsHash(repoRoot, recorded, environment.HOME ?? os.homedir()) !== state.inputsHash) {
    drift.push('.doom configuration changed');
  }
  if (
    JSON.stringify(
      recordResolvedEntries(
        loadMajorModesConfig(repoRoot, environment.HOME ?? os.homedir()),
        createLayerResolvers(repoRoot),
      ),
    ) !== JSON.stringify(state.resolved)
  ) {
    drift.push('resolved extension paths changed');
  }
  if (expectedCompositionFingerprint && state.compositionFingerprint !== expectedCompositionFingerprint) {
    drift.push('extension composition changed');
  }
  try {
    if (!readBootstrapStatus(repoRoot, undefined, environment.HOME ?? os.homedir()).fresh) {
      drift.push('precompiled runtime is missing or stale');
    }
  } catch {
    drift.push('precompiled runtime is missing or stale');
  }

  if (settingsMode === 'persisted') {
    const agentDirectory = piAgentDirectory(environment);
    const themePath = path.join(piThemeDirectory(agentDirectory), `${DEFAULT_THEME_NAME}.json`);
    drift.push(...piIntegrationDrift(agentDirectory));
    if (projectRegistersDoom(repoRoot)) drift.push(DUPLICATE_REGISTRATION_DRIFT);
    if (state.baseline.themePath !== themePath || state.baseline.themeName !== DEFAULT_THEME_NAME) {
      drift.push('synced theme location is out of date');
    }
  }
  const sharedDrift = readSyncDrift({ repoRoot, homeDirectory: environment.HOME ?? os.homedir() });
  const sharedMessages: Partial<Record<SyncDriftReason, string>> = {
    'never-synced': 'sync registration is missing or invalid',
    'code-changed': 'cockpit sources changed since the last sync',
    'cockpit-bundle-missing': 'cockpit bundle is missing',
    'package-apis-missing': 'package API routes are missing',
    'server-bundle-stale': 'server bundle is missing or stale',
    'mcp-bundle-stale': 'MCP bundle is missing or stale',
  };
  for (const reason of sharedDrift.reasons) {
    const message = sharedMessages[reason];
    if (message) drift.push(message);
  }
  return drift;
}

/** Returns true when a valid legacy registration must be republished with API metadata. */
export function syncRegistrationNeedsApiMigration(repoRoot: string, homeDirectory: string): boolean {
  try {
    const registration = readSyncRegistration(repoRoot, homeDirectory);
    return (
      registration !== undefined &&
      (registration.version !== SYNC_REGISTRATION_VERSION || registration.package.apiVersion === undefined)
    );
  } catch {
    return false;
  }
}
