import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { filterHookDisabledLayers, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { buildHarnessContext } from '../adapters/harnessContext.ts';
import { ensureLayerPackages, missingLayerPackageSpecifiers } from '../adapters/layerPackageInstaller.ts';
import { readBootstrapStatus } from '../adapters/bootstrapLocator.ts';
import { DOOM_PACKAGE_NAME } from '../adapters/doomPackage.ts';
import { doomPiPackageRoot, piExtensionAliasIsCurrent } from '../adapters/piExtensionAlias.ts';
import {
  mergePiSettings,
  piAgentDirectory,
  piThemeDirectory,
  readPiSettings,
  serializePiSettings,
} from '../adapters/piSettings.ts';
import {
  DUPLICATE_REGISTRATION_DRIFT,
  projectRegistersDoom,
  writeProjectPiSettings,
} from '../adapters/projectPiSettings.ts';
import { buildSyncedRuntime } from '../adapters/syncedRuntimeBuilder.ts';
import { acquireSyncLocationLock, resolveSyncLocation, syncGenerationDirectory } from '../adapters/syncLocation.ts';
import {
  publishSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
  type SyncPackageRegistration,
} from '../adapters/syncRegistration.ts';
import { readSyncDrift } from '../adapters/syncDrift.ts';
import { syncApiRoutes } from '../adapters/apiRoutesSync.ts';
import { syncWebBundle } from '../adapters/webBundleSync.ts';
import {
  computeInputsHash,
  computeWebSourcesHash,
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
import { DEFAULT_THEME, DEFAULT_THEME_NAME } from '@agimon-ai/doompi-ui/theme';
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
/** Republishes even when nothing drifted, for a generation suspected of being damaged. */
const FORCE_OPTION = '--force';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const PERSONA_FILE_ENV = 'DOOMPI_PERSONA_FILE';
const HOOK_EMITTER = path.join('tools', 'harness', 'emit-hooks.mjs');
const NONE = '(none)';
const PRIVATE_DIRECTORY_MODE = 0o700;
/** Published generations kept behind the current one, so a running hub mid-read survives a prune. */
const RETAINED_GENERATIONS = 1;
const SYNC_LABEL = 'sync';
const RUNTIME_LABEL = 'runtime';
const WEB_LABEL = 'web';
const API_LABEL = 'api';

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
  /** Internal pipeline seam when the caller owns the worktree lock. */
  lockHeld?: boolean;
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
    const settings = readPiSettings(agentDirectory);
    const merged = mergePiSettings(settings, agentDirectory, { themePath, themeName: DEFAULT_THEME_NAME });
    if (serializePiSettings(merged) !== serializePiSettings(settings)) {
      drift.push('Pi user settings are out of date; run doompi init');
    }
    if (projectRegistersDoom(repoRoot)) drift.push(DUPLICATE_REGISTRATION_DRIFT);
    if (!piExtensionAliasIsCurrent(agentDirectory)) drift.push('Pi user dispatcher is out of date; run doompi init');
    const expectedTheme = `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`;
    if (!fs.existsSync(themePath) || fs.readFileSync(themePath, 'utf8') !== expectedTheme) {
      drift.push('Pi user theme is out of date; run doompi init');
    }
    if (state.baseline.themePath !== themePath || state.baseline.themeName !== DEFAULT_THEME_NAME) {
      drift.push('synced theme location is out of date');
    }
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

/**
 * The DoomPi package a repository pins for itself, if it pins one.
 *
 * Extensions are version-coupled to the harness that loads them, so the
 * registration must name the copy the repository resolves rather than whichever
 * copy happened to run sync. A globally installed DoomPi syncing a repository
 * that pins its own would otherwise record itself, and the dispatcher would
 * then load the wrong harness for every session in that repository.
 */
function repositoryPackageRoot(repoRoot: string): string | undefined {
  try {
    return path.dirname(
      createRequire(path.join(repoRoot, 'package.json')).resolve(`${DOOM_PACKAGE_NAME}/package.json`),
    );
  } catch {
    // Not pinned here, which is normal; the executing package stands in.
    return undefined;
  }
}

function packageRegistrationFor(repoRoot: string): SyncPackageRegistration {
  const root = fs.realpathSync(repositoryPackageRoot(repoRoot) ?? doomPiPackageRoot());
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    version?: unknown;
    pi?: { extensions?: unknown };
  };
  const version = manifest.version;
  const extensions = manifest.pi?.extensions;
  const extension = Array.isArray(extensions) ? extensions.find((value) => typeof value === 'string') : undefined;
  if (typeof version !== 'string' || typeof extension !== 'string') {
    throw new Error(`Installed DoomPi package at ${root} has no versioned Pi extension entry`);
  }
  return {
    root,
    version,
    manifestPath,
    entry: fs.realpathSync(path.resolve(root, extension)),
  };
}

/**
 * Removes generations the published one replaced.
 *
 * Each generation holds a full cockpit bundle and runtime, so keeping every one
 * ever built grows without bound. One superseded generation is retained because
 * a hub that resolved its assets a moment ago may still be reading them; older
 * ones have no reader left. Ordered by directory name, whose leading timestamp
 * makes publication order recoverable without reading each state file.
 */
function pruneSupersededGenerations(
  generationsDirectory: string,
  published: string,
  onNotice: (message: string) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(generationsDirectory, { withFileTypes: true });
  } catch (error) {
    // Nothing to prune is indistinguishable from an unreadable directory here,
    // and neither is worth failing a sync that already published.
    onNotice(`could not list generations to prune: ${describeError(error)}`);
    return;
  }
  const superseded = entries
    .filter((entry) => entry.isDirectory() && entry.name !== published)
    .map((entry) => entry.name)
    .sort();
  const removable = superseded.slice(0, Math.max(0, superseded.length - RETAINED_GENERATIONS));
  for (const name of removable) {
    try {
      fs.rmSync(path.join(generationsDirectory, name), { recursive: true, force: true });
    } catch (error) {
      // A generation still held open elsewhere stays; the next sync retries it.
      onNotice(`could not remove superseded generation ${name}: ${describeError(error)}`);
    }
  }
  if (removable.length > 0) onNotice(`pruned ${String(removable.length)} superseded generation(s)`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves the matrix, stages it into home-scoped worktree storage, and publishes one generation. */
export class SyncCommand {
  readonly name = SYNC_COMMAND;
  private readonly settingsMode: SyncSettingsMode;
  private readonly homeDirectory: string | undefined;
  private readonly lockHeld: boolean;

  constructor(options: SyncCommandOptions = {}) {
    this.settingsMode = options.settingsMode ?? 'persisted';
    this.homeDirectory = options.homeDirectory;
    this.lockHeld = options.lockHeld ?? false;
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
    const force = args.includes(FORCE_OPTION);
    const rest = args.slice(1).filter((argument) => argument !== CHECK_OPTION && argument !== FORCE_OPTION);
    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(currentDirectory);
    const homeDirectory = this.homeDirectory ?? environment.HOME ?? os.homedir();
    const defaultMajorMode = loadMajorModesConfig(repoRoot, homeDirectory).defaultMajorMode;
    const defaultDomains = loadDomains(repoRoot, homeDirectory).defaultDomains;
    const parsed = parseHarnessArgs(
      rest,
      selectionEnvironment(repoRoot, environment),
      currentDirectory,
      defaultMajorMode,
      defaultDomains,
    );
    const selection = toSelection(parsed.options);
    const agentDirectory = piAgentDirectory(environment, homeDirectory);
    if (this.settingsMode === 'persisted' && !check) {
      const themePath = path.join(piThemeDirectory(agentDirectory), `${DEFAULT_THEME_NAME}.json`);
      const settings = readPiSettings(agentDirectory);
      const expectedSettings = mergePiSettings(settings, agentDirectory, {
        themePath,
        themeName: DEFAULT_THEME_NAME,
      });
      const expectedTheme = `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`;
      const ready =
        piExtensionAliasIsCurrent(agentDirectory) &&
        serializePiSettings(expectedSettings) === serializePiSettings(settings) &&
        fs.existsSync(themePath) &&
        fs.readFileSync(themePath, 'utf8') === expectedTheme;
      if (!ready) {
        throw new Error('DoomPi Pi integration is not initialized. Run doompi init before doompi sync.');
      }
    }
    if (check) {
      const majorModesConfig = loadMajorModesConfig(repoRoot, homeDirectory);
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
      const expectedCompositionFingerprint = selectionCompositionFingerprint(repoRoot, parsed.options, homeDirectory);
      const drift = collectDrift(
        repoRoot,
        selection,
        located?.state,
        environment,
        this.settingsMode,
        expectedCompositionFingerprint,
      );
      if (drift.length === 0) {
        output.write('doompi sync is up to date\n');
        return 0;
      }
      output.write(`doompi sync is out of date:\n${drift.map((entry) => `  ${entry}`).join('\n')}\n`);
      return 1;
    }

    // Publishing an identical generation is not a no-op: it moves the
    // registration, so every attached cockpit reloads and the previous
    // generation becomes garbage. Same inputs, same published result.
    if (!force && readSyncDrift({ repoRoot, homeDirectory }).fresh) {
      output.write('doompi sync is already up to date\n');
      return 0;
    }

    const progress = new SyncProgress(output);
    const releaseLock = this.lockHeld
      ? undefined
      : await acquireSyncLocationLock(resolveSyncLocation(repoRoot, homeDirectory));
    let result: SyncResult;
    try {
      result = await this.stage(repoRoot, parsed.options, environment, homeDirectory, progress);
    } finally {
      await releaseLock?.();
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
    const generation = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    const directory = syncGenerationDirectory(location, generation);
    await fs.promises.mkdir(location.generationsDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // The leaf is created without `recursive`, so an existing path is an error
    // rather than something to adopt: the cockpit signs and serves whatever the
    // published generation holds, and sync must only ever publish bytes it
    // wrote itself into a directory it just created.
    await fs.promises.mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });

    try {
      const staged = progress.start(SYNC_LABEL, 'resolving the matrix and staging resources');
      const context = await buildHarnessContext({
        ...options,
        repoRoot: location.root,
        homeDirectory,
        cwd: location.root,
        resourceDirectory: directory,
      });
      await ensureLayerPackages({
        repoRoot: location.root,
        config: context.majorModesConfig,
        layers: Object.keys(context.majorModesConfig.layers),
        environment,
      });
      staged(`${String(context.resources.skillCount)} skills, ${String(context.resources.agentCount)} agents`);
      const selection = toSelection(options);
      const resolvers = createLayerResolvers(location.root);
      const resolved = recordResolvedEntries(context.majorModesConfig, resolvers);
      const compositionFingerprint = selectionCompositionFingerprint(location.root, options, homeDirectory);
      const agentDirectory = piAgentDirectory(environment, homeDirectory);
      const persistedThemePath = path.join(piThemeDirectory(agentDirectory), `${DEFAULT_THEME_NAME}.json`);
      const themePath = this.settingsMode === 'persisted' ? persistedThemePath : context.defaultThemePath;
      const state: SyncState = {
        version: SYNC_STATE_VERSION,
        root: location.root,
        identity: location.identity,
        inputsHash: computeInputsHash(location.root, selection, homeDirectory),
        webSourcesHash: computeWebSourcesHash(resolved),
        compositionFingerprint,
        selection,
        env: recordedEnvironment(context.environment),
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

      const precompiled = progress.start(RUNTIME_LABEL, 'precompiling the mode bundles');
      const synced = await buildSyncedRuntime(location.root, environment, homeDirectory, { state, directory });
      precompiled(`${String(Object.keys(synced.bundles).length)} mode bundles`);
      const statePath = await writeSyncState(
        location.root,
        synced.state,
        homeDirectory,
        path.join(directory, 'state.json'),
      );

      const webProgress = progress.start(WEB_LABEL, 'bundling the web cockpit plugins');
      const web = await syncWebBundle({
        repoRoot: location.root,
        resolvedEntries: synced.state.resolved,
        environment,
        outputDirectory: path.join(directory, 'web-bundle'),
        onNotice: (message) => progress.line(WEB_LABEL, message),
      });
      if (web.status === 'failed') throw new Error(`Cockpit bundle failed: ${web.reason}`);
      webProgress(web.status === 'bundled' ? `cockpit bundled with plugins: ${web.pluginIds.join(', ')}` : web.reason);

      const apiProgress = progress.start(API_LABEL, 'generating the package API routes');
      const api = syncApiRoutes({
        resolvedEntries: synced.state.resolved,
        outputDirectory: path.join(directory, 'api'),
        onNotice: (message) => progress.line(API_LABEL, message),
      });
      apiProgress(`routes written to ${api.directory}`);

      publishSyncRegistration(
        location.root,
        {
          version: SYNC_REGISTRATION_VERSION,
          root: location.root,
          identity: location.identity,
          generation,
          generationRoot: directory,
          statePath,
          stateSha256: syncStateSha256(statePath),
          webDirectory: web.status === 'bundled' ? web.assetsDir : null,
          apiDirectory: api.directory,
          package: packageRegistrationFor(location.root),
        },
        homeDirectory,
      );
      pruneSupersededGenerations(location.generationsDirectory, generation, (message) =>
        progress.line(SYNC_LABEL, message),
      );
      const projectSettingsPath = this.settingsMode === 'persisted' ? writeProjectPiSettings(location.root) : undefined;

      return {
        statePath,
        ...(projectSettingsPath ? { projectSettingsPath } : {}),
        selection,
        mcpServers: synced.state.baseline.mcpConfigPath ? readMcpServerNames(synced.state.baseline.mcpConfigPath) : [],
        skillCount: context.resources.skillCount,
        agentCount: context.resources.agentCount,
      };
    } catch (error) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
