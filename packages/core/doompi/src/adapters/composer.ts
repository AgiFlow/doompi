import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMajorModesConfig, type MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { withExtensionSource } from '@agimon-ai/doompi-ui/extensionName';
import { type ExtensionAPI, parseArgs } from '@earendil-works/pi-coding-agent';
import { PERSONA_ENTRY, packageAttribution, resolveExtensionComposition } from '../services/extensionAssembler.ts';
import type { HarnessPreset } from '../types/interfaces/harness';
import { findSyncedRoot, readBundleStatus } from './bootstrapLocator.ts';
import { alreadyComposed } from '@agimon-ai/doompi-extension-contracts/child-process';
import { DOOM_CORDIS_HOST_REQUIRED_ENV } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { COMPOSED_ENV, EXTERNAL_EXTENSIONS_ENV, MUTE_ENV } from './compositionState.ts';
import {
  createHarnessSession,
  getHarnessState,
  type HarnessState,
  loadHarnessState,
  readHarnessState,
  updateHarnessState,
} from './config/harnessState.ts';
import { configurePreset } from './harnessContext.ts';
import { computeInputsHash, createMapResolvers, readSyncState, runDirectory, type SyncState } from './syncState.ts';

export { findSyncedRoot } from './bootstrapLocator.ts';
export { alreadyComposed } from '@agimon-ai/doompi-extension-contracts/child-process';
export { COMPOSED_ENV, EXTERNAL_EXTENSIONS_ENV, MUTE_ENV } from './compositionState.ts';

/**
 * The runtime half of `doom-pi sync`.
 *
 * Pi's own config carries a single entry, the doom-pi extension, and this is
 * what that entry runs: hydrate the harness environment, apply the startup
 * flags, then load the extension set the matrix selects. It runs again on every
 * `/reload`, which is what lets `/mode` swap the set without a restart,
 * since Pi rebuilds its extension runner from whatever a reload produced.
 */

const ENABLED_FLAG = '1';
const SUBAGENT_AGENT_DIRS_ENV = 'PI_SUBAGENT_EXTRA_AGENT_DIRS';
const SUBAGENT_SKILL_DIRS_ENV = 'PI_SUBAGENT_EXTRA_SKILL_DIRS';
const DOMAIN_SEPARATOR = ',';
const PRIVATE_DIRECTORY_MODE = 0o700;
const DOMAIN_APPLY_MODULE = '@agimon-ai/doompi-domain/apply';
const SELECTION_SWITCH_MODULE = '@agimon-ai/doompi-config/selectionSwitch';
const NOT_SYNCED = 'doompi is configured for Pi but this repository was never synced. Run doompi sync.';
const UNUSABLE_STATE_MESSAGE = 'doompi could not read its synchronized state. Run doompi sync.';
const TIMING_ENABLED = process.env.DOOMPI_TIMING === ENABLED_FLAG || process.env.PI_TIMING === ENABLED_FLAG;

export const DOOM_FLAGS = {
  majorMode: 'major-mode',
  domains: 'domains',
  profile: 'profile',
  mute: 'mute',
} as const;

/** Removed flag, reported rather than ignored when a synced session passes it. */
export const REMOVED_LAYER_FLAG = 'layer';

export interface StartupFlags {
  majorMode?: string;
  domains?: string[];
  profile?: string;
  mute: boolean;
  /** True when the caller passed the removed `--layer` flag. */
  removedLayer: boolean;
}

export interface ComposeOutcome {
  /** Everything that went wrong, reported once the session can show messages. */
  problems: string[];
  /** Config changed since the last sync, which is a prompt to re-sync. */
  stale: boolean;
  loaded: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * True when this process was handed the doom extension set on the command line.
 *
 * The launcher and detached Doom Team children both pass the composed list as
 * `--extension` arguments, and Pi merges those with whatever project settings
 * declare. Composing again here would load every extension twice, which Pi
 * reports as each tool and flag conflicting with itself.
 *
 * Matching against the synced paths rather than the mere presence of
 * `--extension` keeps an unrelated one-off, `pi -e ./debug.ts`, from silently
 * costing the user their whole setup.
 */
export function extensionsProvidedExternally(argv: string[], resolved: Record<string, string>): boolean {
  const { extensions } = parseArgs(argv);
  if (!extensions || extensions.length === 0) return false;
  const composed = new Set(Object.values(resolved).map(realPath));
  return extensions.some((entry) => composed.has(realPath(entry)));
}

/**
 * Opens this process's session from what sync pinned.
 *
 * The synced record is decoded underneath the live environment, so an inherited
 * value still wins: a launcher run, a nested session, or a CI override is more
 * specific than anything sync wrote. The result becomes the session's state
 * file, which is the authority from here on; the environment it publishes is
 * for the bash hooks and the packages that can only read one.
 */
export async function startSyncedSession(
  state: SyncState,
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HarnessState> {
  const directory = await prepareRunDirectory(repoRoot, environment);
  const harness: HarnessState = {
    ...readHarnessState({ ...state.env, ...environment }),
    // Recorded separately because no variable carries them.
    ...state.fileState,
    // Every synced process gets private mutable staging. The source content
    // identity is unchanged because the projection fingerprint excludes it.
    mcpProjection: {
      ...state.fileState.mcpProjection,
      stagingDirectory: directory,
    },
    temporaryDirectory: directory,
  };
  createHarnessSession(harness, { directory, environment });
  // The profile's own defaults, which the launcher applies at spawn. They are
  // recorded as a map rather than as variables so /profile can tell which ones
  // it owns when it swaps them out later.
  for (const [key, value] of Object.entries(harness.profileEnvironment)) {
    if (environment[key] === undefined) environment[key] = value;
  }
  return harness;
}

/**
 * Reads the doom flags off the command line.
 *
 * Pi collects unrecognized flags for extensions but hands their values back
 * only after every extension has loaded, which is too late to decide what to
 * load. Parsing argv with Pi's own parser keeps the value rules identical.
 */
export function readStartupFlags(argv: string[]): StartupFlags {
  const { unknownFlags } = parseArgs(argv);
  const text = (name: string): string | undefined => {
    const value = unknownFlags.get(name);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const domains = text(DOOM_FLAGS.domains);
  return {
    majorMode: text(DOOM_FLAGS.majorMode),
    domains: domains
      ?.split(DOMAIN_SEPARATOR)
      .map((name) => name.trim())
      .filter(Boolean),
    profile: text(DOOM_FLAGS.profile),
    mute: unknownFlags.get(DOOM_FLAGS.mute) !== undefined,
    removedLayer: unknownFlags.get(REMOVED_LAYER_FLAG) !== undefined,
  };
}

/** Registers the flags so Pi accepts them and lists them in `pi --help`. */
export function registerDoomFlags(pi: Pick<ExtensionAPI, 'registerFlag'>): void {
  pi.registerFlag(DOOM_FLAGS.majorMode, {
    type: 'string',
    description: 'Named major mode from .doom/modes.yaml',
  });
  pi.registerFlag(DOOM_FLAGS.domains, { type: 'string', description: 'Comma-separated content domains' });
  pi.registerFlag(DOOM_FLAGS.profile, { type: 'string', description: 'Persona and env from .doom/profiles.yaml' });
  pi.registerFlag(DOOM_FLAGS.mute, { type: 'boolean', description: 'Disable the notification extension' });
}

/**
 * Applies the startup flags through the same switchers the slash commands use.
 *
 * A bad value is collected rather than thrown: a factory that throws takes the
 * whole doom setup down with it, which is far worse than one unapplied flag.
 */
export async function applyStartupFlags(
  flags: StartupFlags,
  majorModesConfig: MajorModesConfig,
  repoRoot: string,
  problems: string[],
): Promise<void> {
  // Reported rather than ignored: Pi hands unrecognized flags to extensions, so
  // a stale `--layer dev` would otherwise start a session on the wrong mode
  // without saying anything.
  if (flags.removedLayer) problems.push(`--${REMOVED_LAYER_FLAG} was replaced by --${DOOM_FLAGS.majorMode}`);
  if (flags.majorMode) {
    try {
      const { applyMajorMode } = await import(SELECTION_SWITCH_MODULE);
      applyMajorMode(majorModesConfig, flags.majorMode, getHarnessState());
    } catch (error) {
      problems.push(`--${DOOM_FLAGS.majorMode} ${flags.majorMode}: ${message(error)}`);
    }
  }
  if (flags.domains && flags.domains.length > 0) {
    try {
      const { applyDomains } = await import(DOMAIN_APPLY_MODULE);
      await applyDomains(flags.domains, getHarnessState());
    } catch (error) {
      problems.push(`--domains ${flags.domains.join(DOMAIN_SEPARATOR)}: ${message(error)}`);
    }
  }
  if (flags.profile) {
    try {
      const [{ applyProfile }, { resolveProfile }] = await Promise.all([
        import(SELECTION_SWITCH_MODULE),
        import('@agimon-ai/doompi-config/profiles'),
      ]);
      await applyProfile(resolveProfile(repoRoot, flags.profile), getHarnessState());
    } catch (error) {
      problems.push(`--profile ${flags.profile}: ${message(error)}`);
    }
  }
}

/**
 * Points harness state at a per-process directory before anything writes there.
 *
 * The synced directory is a baseline that every session reads; live switches
 * materialize into this one instead, so a second session in the same repository
 * cannot overwrite what the first is using.
 */
export async function prepareRunDirectory(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const directory = runDirectory(repoRoot, process.pid, environment.HOME ?? os.homedir());
  await fs.promises.mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  // Through the store rather than the environment: the state file is the
  // authority, and a switcher reading a stale directory would write a live
  // session's resources into the wrong place.
  updateHarnessState({ temporaryDirectory: directory }, environment);
  return directory;
}

/** Removes this session's scratch directory. */
export async function cleanupRunDirectory(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await fs.promises.rm(runDirectory(repoRoot, process.pid, environment.HOME ?? os.homedir()), {
    recursive: true,
    force: true,
  });
}

/**
 * Builds the ordered list of extensions to load for the current state.
 *
 * Returns entries in actual Pi factory activation order. CLI argument adaptation
 * remains a launcher concern and synchronized bundles preserve this same order.
 */
export interface ComposedRuntimeLoadPlan {
  readonly entries: string[];
  readonly fingerprint: string;
}

/** Builds the canonical synchronized activation plan. */
export async function composeRuntimeLoadPlan(
  state: SyncState,
  harness: HarnessState = getHarnessState(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ComposedRuntimeLoadPlan> {
  const repoRoot = harness.root ?? state.root;
  const resolvers = createMapResolvers(state.resolved, state.compiled);
  const context = {
    agents: harness.agents,
    // Exiting when the agent settles is a launcher decision with no synced
    // equivalent: a session started by hand is meant to stay open.
    autoStop: false,
    preset: state.selection.preset,
    personaEntry: resolvers.packageEntry(PERSONA_ENTRY),
    majorMode: harness.majorMode,
    layers: [...harness.layers],
    majorModesConfig: loadMajorModesConfig(repoRoot),
    resolvers,
  };

  // A state field, so it goes through the store: Doom Team reads it from the
  // environment the store publishes when it builds a child's spawn snapshot.
  const composition = resolveExtensionComposition({
    ...context,
    mute: environment[MUTE_ENV] === ENABLED_FLAG,
  });
  environment[DOOM_CORDIS_HOST_REQUIRED_ENV] = ENABLED_FLAG;
  updateHarnessState(
    {
      childExtensions: [...composition.childActivation],
      compositionFingerprint: composition.fingerprint,
      packageAttribution: packageAttribution(composition),
    },
    environment,
  );
  if (harness.agents) {
    environment[SUBAGENT_AGENT_DIRS_ENV] = harness.agentDirectories.join(path.delimiter);
    environment[SUBAGENT_SKILL_DIRS_ENV] = harness.skillDirectories.join(path.delimiter);
  }
  const entries = [...composition.parentActivation];
  const bundle = state.bundles?.[composition.fingerprint];
  return {
    entries: bundle ? [bundle] : entries,
    fingerprint: composition.fingerprint,
  };
}

/** Compatibility view for callers that only need Pi extension entries. */
export async function composeLoadOrder(
  state: SyncState,
  harness: HarnessState = getHarnessState(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return (await composeRuntimeLoadPlan(state, harness, environment)).entries;
}

/**
 * Imports each extension and hands it a source-aware view of the Pi API.
 *
 * Every Pi extension entry is a factory of the same shape, so one extension can
 * activate the rest. The view delegates to the same host API while retaining the
 * entry path for tools registered through a composed loader. Failures are per
 * entry: one unloadable module must not cost the session everything after it.
 */
export async function loadComposedExtensions(
  pi: ExtensionAPI,
  entries: string[],
  problems: string[],
): Promise<string[]> {
  const loaded: string[] = [];
  for (const entry of entries) {
    const importStartedAt = performance.now();
    let module: { default?: unknown };
    try {
      module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
      if (TIMING_ENABLED) {
        process.stderr.write(`[doompi:timing] import ${(performance.now() - importStartedAt).toFixed(1)}ms ${entry}\n`);
      }
    } catch (error) {
      problems.push(`${entry}: ${message(error)}`);
      continue;
    }
    if (typeof module.default !== 'function') {
      problems.push(`${entry}: does not export an extension factory`);
      continue;
    }
    const factoryStartedAt = performance.now();
    try {
      await (module.default as (api: ExtensionAPI) => void | Promise<void>)(withExtensionSource(pi, entry));
      if (TIMING_ENABLED) {
        process.stderr.write(
          `[doompi:timing] factory ${(performance.now() - factoryStartedAt).toFixed(1)}ms ${entry}\n`,
        );
      }
      loaded.push(entry);
    } catch (error) {
      problems.push(`${entry}: ${message(error)}`);
    }
  }
  return loaded;
}

export interface ComposeOptions {
  cwd?: string;
  argv?: string[];
  environment?: NodeJS.ProcessEnv;
}

/**
 * Runs the whole synced startup for one Pi session.
 *
 * Never throws: whatever fails is reported through the outcome so the session
 * still starts and can say what is wrong.
 */
export async function composeDoomSession(pi: ExtensionAPI, options: ComposeOptions = {}): Promise<ComposeOutcome> {
  const environment = options.environment ?? process.env;
  const problems: string[] = [];
  const homeDirectory = environment.HOME ?? os.homedir();
  const repoRoot = findSyncedRoot(options.cwd ?? process.cwd(), homeDirectory);
  if (!repoRoot) return { problems: [NOT_SYNCED], stale: false, loaded: [] };

  let state: SyncState | undefined;
  try {
    state = readSyncState(repoRoot, homeDirectory);
  } catch (error) {
    return { problems: [message(error)], stale: false, loaded: [] };
  }
  if (!state) return { problems: [NOT_SYNCED], stale: false, loaded: [] };

  const argv = options.argv ?? process.argv.slice(2);
  // The launcher and Doom Team children compose the set themselves and pass it
  // in, so this entry has nothing left to do but stay out of the way.
  if (
    environment[EXTERNAL_EXTENSIONS_ENV] === ENABLED_FLAG ||
    extensionsProvidedExternally(argv, { ...state.resolved, ...state.bundles })
  ) {
    return { problems: [], stale: false, loaded: [] };
  }

  configurePreset({ preset: state.selection.preset as HarnessPreset, piArgs: [] }, environment);

  // Only the first load opens a session. A reload finds the pointer this set
  // and reads the file back, which is what carries a live /domains or /profile
  // switch across the reload instead of resetting it to what sync pinned.
  if (!alreadyComposed(environment)) {
    environment[COMPOSED_ENV] = ENABLED_FLAG;
    await startSyncedSession(state, repoRoot, environment);
    const flags = readStartupFlags(argv);
    if (flags.mute) environment[MUTE_ENV] = ENABLED_FLAG;
    await applyStartupFlags(flags, loadMajorModesConfig(repoRoot), repoRoot, problems);
  }

  let loadPlan: ComposedRuntimeLoadPlan;
  try {
    // Read back through the store rather than from this process: the startup
    // flags may have switched the layer or the domains a moment ago, and the
    // environment being managed is not always this process's own.
    loadPlan = await composeRuntimeLoadPlan(state, loadHarnessState(environment).state, environment);
  } catch (error) {
    return { problems: [...problems, message(error)], stale: false, loaded: [] };
  }

  const selectedBundle = state.bundles?.[loadPlan.fingerprint];
  if (selectedBundle) {
    try {
      const status = readBundleStatus(repoRoot, loadPlan.fingerprint, homeDirectory);
      if (!status.fresh || status.bundle !== selectedBundle) {
        return { problems: [...problems, UNUSABLE_STATE_MESSAGE], stale: false, loaded: [] };
      }
    } catch {
      return { problems: [...problems, UNUSABLE_STATE_MESSAGE], stale: false, loaded: [] };
    }
  }

  const loaded = await loadComposedExtensions(pi, loadPlan.entries, problems);
  return {
    problems,
    stale:
      computeInputsHash(repoRoot, state.selection, homeDirectory) !== state.inputsHash ||
      (loadHarnessState(environment).state.majorMode === state.selection.majorMode &&
        loadPlan.fingerprint !== state.compositionFingerprint),
    loaded,
  };
}
