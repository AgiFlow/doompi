import fs from 'node:fs';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { createLayerResolvers, PERSONA_ENTRY, resolveExtensionComposition } from '../services/extensionAssembler.ts';
import { getHarnessState } from './config/harnessState.ts';
import {
  LAUNCHER_COMPOSITION_ENV,
  LAUNCHER_COMPOSITION_VERSION,
  type LauncherCompositionState,
} from '../types/interfaces/launcherComposition';
import { writeFileAtomic } from './serialization/json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bundleRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Records what a launcher session's stable entry needs, for the entry to read back. */
export function writeLauncherComposition(target: string, state: LauncherCompositionState): void {
  writeFileAtomic(target, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The composition record this session was started with, when it has one.
 *
 * A session launched the historical way has no record and no environment
 * pointer, so every reader treats undefined as "not a composing launcher"
 * rather than as a failure.
 */
export function readLauncherComposition(
  environment: NodeJS.ProcessEnv = process.env,
): LauncherCompositionState | undefined {
  const target = environment[LAUNCHER_COMPOSITION_ENV];
  if (!target) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    // An unreadable record leaves the session on its startup composition,
    // which is strictly better than refusing to load any extension at all.
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== LAUNCHER_COMPOSITION_VERSION || typeof parsed.root !== 'string') {
    return undefined;
  }
  return {
    version: LAUNCHER_COMPOSITION_VERSION,
    root: parsed.root,
    preset: typeof parsed.preset === 'string' ? parsed.preset : 'default',
    mute: parsed.mute === true,
    autoStop: parsed.autoStop === true,
    agents: parsed.agents !== false,
    bundles: bundleRecord(parsed.bundles),
  };
}

export interface LauncherLoadPlan {
  /** Entries in Pi factory activation order: one aggregate, or the sources. */
  entries: string[];
  fingerprint: string;
  childExtensions: string[];
}

/**
 * Resolves this session's composition from the selection that is live now.
 *
 * The major mode and layers come from harness state rather than the record, so
 * a `/mode` switch that persisted its selection before reloading lands on the
 * new composition. Where the synced path can rely on sync having precompiled
 * every combination, a launcher session may be asking for one that was never
 * built; the individual entries are the answer then, and the aggregate is an
 * optimisation applied when it happens to exist.
 */
export function resolveLauncherLoadPlan(
  state: LauncherCompositionState,
  harness = getHarnessState(),
  exists: (file: string) => boolean = fs.existsSync,
): LauncherLoadPlan {
  const repoRoot = harness.root ?? state.root;
  const resolvers = createLayerResolvers(repoRoot);
  const composition = resolveExtensionComposition({
    agents: state.agents,
    autoStop: state.autoStop,
    mute: state.mute,
    preset: state.preset,
    personaEntry: resolvers.packageEntry(PERSONA_ENTRY),
    majorMode: harness.majorMode,
    layers: [...harness.layers],
    majorModesConfig: loadMajorModesConfig(repoRoot),
    resolvers,
  });
  const bundle = state.bundles[composition.fingerprint];
  return {
    entries: bundle && exists(bundle) ? [bundle] : [...composition.parentActivation],
    fingerprint: composition.fingerprint,
    childExtensions: [...composition.childActivation],
  };
}
