import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterHookDisabledLayers, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { buildHarnessContext } from '../adapters/harnessContext.ts';
import { ensureLayerPackages, missingLayerPackageSpecifiers } from '../adapters/layerPackageInstaller.ts';
import { readBootstrapStatus } from '../adapters/bootstrapLocator.ts';
import { piExtensionAliasIsCurrent, writePiExtensionAlias } from '../adapters/piExtensionAlias.ts';
import {
  mergePiSettings,
  piAgentDirectory,
  piThemeDirectory,
  readPiSettings,
  serializePiSettings,
  writePiSettings,
} from '../adapters/piSettings.ts';
import {
  DUPLICATE_REGISTRATION_DRIFT,
  projectRegistersDoom,
  writeProjectPiSettings,
} from '../adapters/projectPiSettings.ts';
import { buildSyncedRuntime } from '../adapters/syncedRuntimeBuilder.ts';
import { acquireSyncLocationLock, resolveSyncLocation } from '../adapters/syncLocation.ts';
import {
  computeInputsHash,
  readLocatedSyncState,
  readMcpServerNames,
  recordResolvedEntries,
  SYNC_STATE_VERSION,
  type SyncSelection,
  type SyncState,
  syncStateRootMatches,
  writeSyncState,
} from '../adapters/syncState.ts';
import { HARNESS_STATE_POINTER, loadHarnessState } from '../adapters/config/harnessState';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { DEFAULT_THEME, DEFAULT_THEME_NAME, writeDefaultTheme } from '@agimon-ai/doompi-ui/theme';
import { loadDoomConfig } from '../services/config/projectTrust';
import { createLayerResolvers, PERSONA_ENTRY, resolveExtensionComposition } from '../services/extensionAssembler.ts';
import type { HarnessOptions } from '../types/interfaces/harness';
import { findRepositoryRoot } from '../adapters/repository/repository';
import { DOOMPI_DOMAINS_ENV, DOOMPI_MAJOR_MODE_ENV, DOOMPI_PROFILE_ENV } from './cli/matrixOptions.ts';
import { parseHarnessArgs } from './cli/options.ts';
import { SyncProgress, type SyncProgressOutput } from './syncPresenter.ts';

/**
 * `doom-pi sync`: resolve the matrix once and write it where plain Pi finds it.
 *
 * The doom-emacs split. Everything that needs a real Node process (module
 * resolution, staging skills and agents, generating the MCP config) happens
 * here, and the doom-pi extension then only reads what this produced. The
 * launcher is untouched and keeps resolving the same matrix per run.
 */

const SYNC_COMMAND = 'sync';
const CHECK_OPTION = '--check';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const PERSONA_FILE_ENV = 'DOOMPI_PERSONA_FILE';
const HOOK_EMITTER = path.join('tools', 'harness', 'emit-hooks.mjs');
const RUN_DIRECTORY = 'run';
const EXTENSION_CACHE_DIRECTORY = 'cache';
const MODE_DIST_DIRECTORY = 'dist';
const SYNC_LOCK_FILE = '.sync.lock';
const NONE = '(none)';
const SYNC_LABEL = 'sync';
const RUNTIME_LABEL = 'runtime';

/**
 * Harness variables worth recording, by prefix or exact name.
 *
 * An allowlist rather than the whole environment: the state file is a snapshot
 * of resolved configuration, and dumping `process.env` into it would write
 * every credential the sync happened to run with onto disk.
 */
const RECORDED_PREFIXES = ['DOOMPI_'];
const RECORDED_KEYS = ['CLAUDE_PROJECT_DIR', 'CODEX_REPO_ROOT', 'ORIGINAL_REPO_PATH', 'MCP_UI_VIEWER'];
/**
 * Launcher-only values a synced session must not inherit.
 *
 * The child extension list is recomposed on every load, and the subagent binary
 * points at `pi.sh`, which a session started as plain `pi` should not shell out
 * to: Doom Team resolves Pi's own CLI when the variable is absent.
 */
const EXCLUDED_KEYS = new Set([
  'DOOMPI_CHILD_EXTENSIONS',
  'DOOMPI_COMPOSED',
  'DOOMPI_MUTE',
  'DOOMPI_TEMP_DIR',
  // A pointer to the syncing process's own state file. Recording it would hand
  // every later session a path to a state that died with this one.
  HARNESS_STATE_POINTER,
  'PI_SUBAGENT_PI_BINARY',
]);

type SyncOutput = SyncProgressOutput;

export type SyncSettingsMode = 'persisted' | 'embedded';

export interface SyncCommandOptions {
  settingsMode?: SyncSettingsMode;
  /** Test/embedding override; normal CLI execution uses the process home. */
  homeDirectory?: string;
}

export interface SyncResult {
  statePath: string;
  /** Omitted when DPI supplies the integration as a process-local overlay. */
  settingsPath?: string;
  /** Set only when the repository still carried its own DoomPi registration. */
  projectSettingsPath?: string;
  selection: SyncSelection;
  mcpServers: string[];
  skillCount: number;
  agentCount: number;
}

export function recordedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || EXCLUDED_KEYS.has(key)) continue;
    if (RECORDED_KEYS.includes(key) || RECORDED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      recorded[key] = value;
    }
  }
  return recorded;
}

/**
 * Layers the repository's declared selection under the usual resolution.
 *
 * `.doom/config.yaml` holds what the repository selects by default, the way
 * init.el does for doom-emacs. Seeding the environment the parser reads keeps
 * the precedence the launcher already documents: an explicit flag wins, then an
 * exported variable, then the declared default.
 */
export function selectionEnvironment(repoRoot: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { selection } = loadDoomConfig(repoRoot);
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
): string {
  const majorModesConfig = loadMajorModesConfig(repoRoot);
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
  // Hashed against the recorded selection, not the requested one, so a
  // selection change is reported once rather than as two findings.
  if (computeInputsHash(repoRoot, recorded, environment.HOME ?? os.homedir()) !== state.inputsHash) {
    drift.push('.doom configuration changed');
  }
  // Re-resolving is what catches a dependency upgrade moving a package, which
  // the inputs hash deliberately does not read.
  if (
    JSON.stringify(recordResolvedEntries(loadMajorModesConfig(repoRoot), createLayerResolvers(repoRoot))) !==
    JSON.stringify(state.resolved)
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

  const agentDirectory = piAgentDirectory(environment);
  const themePath = path.join(piThemeDirectory(agentDirectory), `${DEFAULT_THEME_NAME}.json`);
  if (settingsMode === 'persisted') {
    const settings = readPiSettings(agentDirectory);
    const merged = mergePiSettings(settings, agentDirectory, { themePath, themeName: DEFAULT_THEME_NAME });
    if (serializePiSettings(merged) !== serializePiSettings(settings)) {
      drift.push('Pi user settings are out of date');
    }
    if (projectRegistersDoom(repoRoot)) drift.push(DUPLICATE_REGISTRATION_DRIFT);
  }
  if (!piExtensionAliasIsCurrent(agentDirectory)) drift.push('Pi user extension alias is out of date');
  const expectedTheme = `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`;
  if (!fs.existsSync(themePath) || fs.readFileSync(themePath, 'utf8') !== expectedTheme) {
    drift.push('Pi user theme is out of date');
  }
  if (state.baseline.themePath !== themePath || state.baseline.themeName !== DEFAULT_THEME_NAME) {
    drift.push('synced theme location is out of date');
  }
  return drift;
}

/** Regenerates the hook files the other frontends read before any harness code runs. */
function emitFrontendHooks(repoRoot: string, output: SyncOutput): void {
  const emitter = path.join(repoRoot, HOOK_EMITTER);
  if (!fs.existsSync(emitter)) return;
  const result = spawnSync(process.execPath, [emitter, '--write'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status === 0) {
    output.write('hooks:    regenerated for Claude Code and Codex\n');
    return;
  }
  output.write(`hooks:    emit-hooks failed (${result.stderr?.trim() || `exit ${String(result.status)}`})\n`);
}

export function formatSyncResult(result: SyncResult, runner = 'pi'): string {
  const { selection } = result;
  return [
    `mode:     ${selection.majorMode}`,
    `domains:  ${selection.domains.join(', ') || NONE}`,
    `profile:  ${selection.profile ?? NONE}`,
    `skills:   ${result.skillCount}`,
    `agents:   ${result.agentCount}`,
    `mcp:      ${result.mcpServers.join(', ') || NONE}`,
    `state:    ${result.statePath}`,
    ...(result.settingsPath ? [`settings: ${result.settingsPath}`] : []),
    ...(result.projectSettingsPath
      ? [`project:  removed duplicate registration from ${result.projectSettingsPath}`]
      : []),
    '',
    `Run ${runner} from the repository root to use it.`,
    '',
  ].join('\n');
}

/** Resolves the matrix, stages it into home-scoped worktree storage, and points Pi at the result. */
export class SyncCommand {
  readonly name = SYNC_COMMAND;
  private readonly settingsMode: SyncSettingsMode;
  private readonly homeDirectory: string | undefined;

  constructor(options: SyncCommandOptions = {}) {
    this.settingsMode = options.settingsMode ?? 'persisted';
    this.homeDirectory = options.homeDirectory;
  }

  matches(args: string[]): boolean {
    return args[0] === this.name;
  }

  async execute(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
    currentDirectory = process.cwd(),
    output: SyncOutput = process.stdout,
  ): Promise<number> {
    const check = args.includes(CHECK_OPTION);
    const rest = args.slice(1).filter((argument) => argument !== CHECK_OPTION);
    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(currentDirectory);
    const defaultMajorMode = loadMajorModesConfig(repoRoot).defaultMajorMode;
    const defaultDomains = loadDomains(repoRoot).defaultDomains;
    const parsed = parseHarnessArgs(
      rest,
      selectionEnvironment(repoRoot, environment),
      currentDirectory,
      defaultMajorMode,
      defaultDomains,
    );
    const selection = toSelection(parsed.options);
    const homeDirectory = this.homeDirectory ?? environment.HOME ?? os.homedir();

    if (check) {
      const majorModesConfig = loadMajorModesConfig(repoRoot);
      const missingPackages = missingLayerPackageSpecifiers(
        majorModesConfig,
        Object.keys(majorModesConfig.layers),
        createLayerResolvers(repoRoot),
      );
      if (missingPackages.length > 0) {
        output.write(
          `doompi sync is out of date:\n${missingPackages
            .map((specifier) => `  configured package is not installed: ${specifier}`)
            .join('\n')}\n`,
        );
        return 1;
      }
      let located: ReturnType<typeof readLocatedSyncState>;
      try {
        located = readLocatedSyncState(repoRoot, homeDirectory);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        output.write(`doompi sync is out of date:\n  ${detail}\n`);
        return 1;
      }
      const expectedCompositionFingerprint = selectionCompositionFingerprint(repoRoot, parsed.options);
      const drift = collectDrift(
        repoRoot,
        selection,
        located?.state,
        environment,
        this.settingsMode,
        expectedCompositionFingerprint,
      );
      if (located?.layout === 'legacy') drift.unshift('legacy repository-local sync state requires migration');
      if (drift.length === 0) {
        output.write('doompi sync is up to date\n');
        return 0;
      }
      output.write(`doompi sync is out of date:\n${drift.map((entry) => `  ${entry}`).join('\n')}\n`);
      return 1;
    }

    const progress = new SyncProgress(output);
    const releaseLock = await acquireSyncLocationLock(resolveSyncLocation(repoRoot, homeDirectory));
    let result: SyncResult;
    try {
      result = await this.stage(repoRoot, parsed.options, environment, homeDirectory, progress);
    } finally {
      await releaseLock();
    }
    emitFrontendHooks(repoRoot, output);
    output.write(formatSyncResult(result, this.settingsMode === 'embedded' ? 'dpi' : 'pi'));
    return 0;
  }

  private async stage(
    repoRoot: string,
    options: Omit<HarnessOptions, 'repoRoot'>,
    environment: NodeJS.ProcessEnv,
    homeDirectory: string,
    progress: SyncProgress,
  ): Promise<SyncResult> {
    const location = resolveSyncLocation(repoRoot, homeDirectory);
    const directory = location.directory;
    // A full regeneration, so nothing a previous selection staged survives. Keep
    // per-session run directories because another Pi session may be using one,
    // and retain content-addressed cache and dist artifacts across selections.
    const preserved = new Set([RUN_DIRECTORY, EXTENSION_CACHE_DIRECTORY, MODE_DIST_DIRECTORY, SYNC_LOCK_FILE]);
    for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      if (!preserved.has(entry)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
    }

    const staged = progress.start(SYNC_LABEL, 'resolving the matrix and staging resources');
    const context = await buildHarnessContext({
      ...options,
      repoRoot,
      homeDirectory,
      // Sync describes the repository, not the directory it was invoked from.
      cwd: repoRoot,
      resourceDirectory: directory,
    });
    await ensureLayerPackages({
      repoRoot,
      config: context.majorModesConfig,
      layers: Object.keys(context.majorModesConfig.layers),
      environment,
    });
    staged(`${String(context.resources.skillCount)} skills, ${String(context.resources.agentCount)} agents`);
    const selection = toSelection(options);
    const resolvers = createLayerResolvers(repoRoot);
    const resolved = recordResolvedEntries(context.majorModesConfig, resolvers);
    const compositionFingerprint = selectionCompositionFingerprint(repoRoot, options);
    const agentDirectory = piAgentDirectory(environment);
    const themeDirectory = piThemeDirectory(agentDirectory);
    await fs.promises.mkdir(themeDirectory, { recursive: true });
    const themePath = await writeDefaultTheme(themeDirectory);
    if (path.resolve(context.defaultThemePath) !== path.resolve(themePath)) {
      await fs.promises.rm(context.defaultThemePath, { force: true });
    }
    const state: SyncState = {
      version: SYNC_STATE_VERSION,
      root: repoRoot,
      identity: location.identity,
      inputsHash: computeInputsHash(repoRoot, selection, homeDirectory),
      compositionFingerprint,
      selection,
      env: recordedEnvironment(context.environment),
      // Read back from the session file the context just wrote, which is the
      // authority for fields deliberately omitted from the child environment.
      fileState: {
        profileEnvironment: loadHarnessState(context.environment).state.profileEnvironment,
        pluginHooks: context.resources.pluginHooks,
        mcpProjection: context.resources.mcpProjection,
      },
      resolved,
      baseline: {
        mcpConfigPath: context.resources.mcpConfigPath,
        personaFile: context.environment[PERSONA_FILE_ENV],
        themePath,
        themeName: DEFAULT_THEME_NAME,
      },
    };

    const statePath = await writeSyncState(repoRoot, state, homeDirectory);
    const precompiled = progress.start(RUNTIME_LABEL, 'precompiling the mode bundles');
    const synced = await buildSyncedRuntime(repoRoot, environment, homeDirectory);
    precompiled(`${String(Object.keys(synced.bundles).length)} mode bundles`);
    writePiExtensionAlias(agentDirectory);
    const settingsPath =
      this.settingsMode === 'persisted'
        ? writePiSettings(agentDirectory, {
            themePath: state.baseline.themePath,
            themeName: state.baseline.themeName,
          })
        : undefined;
    // After the user scope is current, so the repository is only ever stripped
    // of a registration the user scope already provides.
    const projectSettingsPath = this.settingsMode === 'persisted' ? writeProjectPiSettings(repoRoot) : undefined;

    return {
      statePath,
      ...(settingsPath ? { settingsPath } : {}),
      ...(projectSettingsPath ? { projectSettingsPath } : {}),
      selection,
      mcpServers: state.baseline.mcpConfigPath ? readMcpServerNames(state.baseline.mcpConfigPath) : [],
      skillCount: context.resources.skillCount,
      agentCount: context.resources.agentCount,
    };
  }
}
