import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfigLenient } from '@agimon-ai/doompi-config/majorModes';
import type { ConfigDiagnostic } from '@agimon-ai/doompi-config/types';
import { DOOM_MCP_BUNDLE_FILE } from '@agimon-ai/doompi-core/mcpFacet';
import { piAgentDirectory, piThemeDirectory } from '@agimon-ai/doompi-core/runtimePiSettings';
import { DOOM_SERVER_BUNDLE_FILE } from '@agimon-ai/doompi-core/serverFacet';
import {
  acquireSyncLocationLock,
  resolveSyncLocation,
  syncGenerationDirectory,
} from '@agimon-ai/doompi-core/syncLocation';
import {
  DOOMPI_API_VERSION,
  publishSyncRegistration,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
  type SyncPackageRegistration,
} from '@agimon-ai/doompi-core/syncRegistration';
import { DEFAULT_THEME_NAME } from '@agimon-ai/doompi-ui/theme';

import { buildSyncedRuntime } from '../../../builders/cli';
import { createLayerResolvers, type ExtensionComposition } from '../../../builders/cli/extensionAssembler';
import { buildHarnessContext } from '../../../builders/cli/harnessContext';
import { doomPiPackageRoot, writePiExtensionAlias } from '../../../builders/cli/piExtensionAlias';
import { piExtensionDispatcherIsUpgradeable } from '../../../builders/cli/piExtensionDispatcher';
import { writeProjectPiSettings } from '../../../builders/cli/projectSettings';
import { syncServerBundle } from '../../../builders/server';
import { syncMcpBundle } from '../../../builders/server/mcpBundle';
import { syncWebBundle } from '../../../builders/web';
import { HARNESS_STATE_POINTER, loadHarnessState } from '../../../composition/harnessState';
import { ensureLayerPackages, missingLayerPackageSpecifiers } from '../../../composition/layerPackageInstaller';
import { loadDoomConfigLenient } from '../../../composition/projectTrust';
import { resolveDoomConfigurationRoot } from '../../../composition/repository';
import { readSyncDrift } from '../../../composition/syncDrift';
import {
  computeInputsHash,
  computeMcpSourcesHash,
  computeServerSourcesHash,
  computeWebSourcesHash,
  readLocatedSyncState,
  readMcpServerNames,
  recordResolvedEntries,
  SYNC_STATE_VERSION,
  type SyncSelection,
  type SyncState,
  writeSyncState,
} from '../../../composition/syncState';
import type { HarnessOptions } from '../../../composition/types/harness';
import { DOOMPI_DOMAINS_ENV, DOOMPI_MAJOR_MODE_ENV, DOOMPI_PROFILE_ENV } from '../../matrixOptions';
import { parseHarnessArgs } from '../../options';
import {
  collectDrift,
  piIntegrationDrift,
  selectionCompositionFingerprint,
  selectionEnvironment,
  syncRegistrationNeedsApiMigration,
  toSelection,
  type SyncSettingsMode,
} from './inspection';
import { SyncProgress, type SyncProgressOutput } from './presenter';

export {
  collectDrift,
  selectionCompositionFingerprint,
  selectionEnvironment,
  syncRegistrationNeedsApiMigration,
  toSelection,
  type SyncSettingsMode,
} from './inspection';

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
const GLOBAL_OPTION = '--global';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const PERSONA_FILE_ENV = 'DOOMPI_PERSONA_FILE';
const HOOK_EMITTER = path.join('tools', 'harness', 'emit-hooks.mjs');
const NONE = '(none)';
const PRIVATE_DIRECTORY_MODE = 0o700;
const SYNC_LABEL = 'sync';
const RUNTIME_LABEL = 'runtime';
const WEB_LABEL = 'web';
const API_LABEL = 'api';

export interface SyncRoots {
  globalOnly: boolean;
  globalRoot: string;
  sourceRoot: string;
  targetRoot: string;
}

/** Resolves the configuration source and publication destination for one sync. */
export function resolveSyncRoots(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  homeDirectory = environment.HOME ?? os.homedir(),
): SyncRoots {
  const globalRoot = globalDoomConfigDirectory(homeDirectory);
  const inheritedRoot = environment[HARNESS_ROOT_ENV];
  const sourceRoot = inheritedRoot
    ? path.resolve(inheritedRoot)
    : resolveDoomConfigurationRoot(currentDirectory, homeDirectory);
  const globalOnly = args.includes(GLOBAL_OPTION);
  return { globalOnly, globalRoot, sourceRoot, targetRoot: globalOnly ? globalRoot : sourceRoot };
}

const GLOBAL_SCOPE_INHERITED_KEYS = [
  HARNESS_ROOT_ENV,
  HARNESS_STATE_POINTER,
  DOOMPI_MAJOR_MODE_ENV,
  DOOMPI_DOMAINS_ENV,
  DOOMPI_PROFILE_ENV,
] as const;

/** Removes workspace-only state before a global runtime is resolved. */
export function environmentForSyncScope(environment: NodeJS.ProcessEnv, globalOnly: boolean): NodeJS.ProcessEnv {
  if (!globalOnly) return environment;
  const scoped = { ...environment };
  for (const key of GLOBAL_SCOPE_INHERITED_KEYS) delete scoped[key];
  return scoped;
}

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
 * Reports the config keys sync chose to ignore.
 *
 * Never fatal. A key nobody recognises is usually a config written for another
 * version of a layer, and refusing to build over it is worse than proceeding
 * without it. The strict check lives in `doompi doctor`.
 */
function writeConfigDiagnostics(diagnostics: readonly ConfigDiagnostic[], output: SyncOutput): void {
  if (diagnostics.length === 0) return;
  const lines = diagnostics.map((entry) => `  ${entry.filePath}: ${entry.path}`).join('\n');
  output.write(
    `config:   ignored ${String(diagnostics.length)} unsupported key(s); run doompi doctor for the strict check\n${lines}\n`,
  );
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
 * The DoomPi that produced this generation, which is the one that can load it.
 *
 * Always the executing package, never another copy the repository happens to
 * install. A generation is not portable between two installations: the bundles
 * are compiled from the building package's own extension entries, the recorded
 * compiler inputs are its files, and the state names its bootstrap entry. Naming
 * a second copy here publishes a registration whose package disagrees with the
 * state it points at, and Pi's dispatcher then loads a harness that rejects the
 * bootstrap as stale on every session, with no sync able to fix it.
 *
 * A repository that wants its own copy to own its sessions runs sync with that
 * copy's CLI, which makes it the executing package.
 */
function packageRegistrationFor(): SyncPackageRegistration {
  const root = fs.realpathSync(doomPiPackageRoot());
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    version?: unknown;
    doompiApiVersion?: unknown;
    pi?: { extensions?: unknown };
  };
  const version = manifest.version;
  const apiVersion = manifest.doompiApiVersion;
  const extensions = manifest.pi?.extensions;
  const extension = Array.isArray(extensions) ? extensions.find((value) => typeof value === 'string') : undefined;
  if (
    typeof version !== 'string' ||
    typeof apiVersion !== 'number' ||
    !Number.isSafeInteger(apiVersion) ||
    apiVersion < 1 ||
    apiVersion !== DOOMPI_API_VERSION ||
    typeof extension !== 'string'
  ) {
    throw new Error(`Installed DoomPi package at ${root} has no supported API-versioned Pi extension entry`);
  }
  return {
    root,
    version,
    apiVersion: apiVersion as number,
    manifestPath,
    entry: fs.realpathSync(path.resolve(root, extension)),
  };
}

/** Resolves the matrix, stages it into home-scoped worktree storage, and publishes one generation. */
export async function synchronize(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  output: SyncOutput = process.stdout,
  commandOptions: SyncCommandOptions = {},
): Promise<number> {
  const check = args.includes(CHECK_OPTION);
  const force = args.includes(FORCE_OPTION);
  const rest = args.slice(1).filter((argument) => ![CHECK_OPTION, FORCE_OPTION, GLOBAL_OPTION].includes(argument));
  const homeDirectory = commandOptions.homeDirectory ?? environment.HOME ?? os.homedir();
  const roots = resolveSyncRoots(args, environment, currentDirectory, homeDirectory);
  const { globalOnly, globalRoot, targetRoot: repoRoot } = roots;
  const scopedEnvironment = environmentForSyncScope(environment, globalOnly);
  if (globalOnly && !check) fs.mkdirSync(globalRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // Sync tolerates keys it does not recognise so a config written against a
  // different version cannot break a build. `doompi doctor` reports them.
  const modes = loadMajorModesConfigLenient(repoRoot, homeDirectory);
  const configDiagnostics = [...loadDoomConfigLenient(repoRoot, homeDirectory).diagnostics, ...modes.diagnostics];
  const defaultMajorMode = modes.config.defaultMajorMode;
  const defaultDomains = loadDomains(repoRoot, homeDirectory).defaultDomains;
  const parsed = parseHarnessArgs(
    rest,
    selectionEnvironment(repoRoot, scopedEnvironment, homeDirectory),
    globalOnly ? globalRoot : currentDirectory,
    defaultMajorMode,
    defaultDomains,
  );
  const selection = toSelection(parsed.options);
  const agentDirectory = piAgentDirectory(scopedEnvironment, homeDirectory);
  if ((commandOptions.settingsMode ?? 'persisted') === 'persisted' && !check) {
    if (piExtensionDispatcherIsUpgradeable(agentDirectory)) {
      writePiExtensionAlias(agentDirectory);
      output.write('repair:   refreshed Pi user dispatcher\n');
    }
    const drift = piIntegrationDrift(agentDirectory);
    if (drift.length > 0) {
      throw new Error(`DoomPi Pi integration is not ready:\n${drift.map((entry) => `  ${entry}`).join('\n')}`);
    }
  }
  writeConfigDiagnostics(configDiagnostics, output);
  if (check) {
    const majorModesConfig = modes.config;
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
      scopedEnvironment,
      commandOptions.settingsMode ?? 'persisted',
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
  const driftOptions = {
    repoRoot,
    homeDirectory,
    requireWebBundle: Boolean(environment.DOOMPI_WEB_PACKAGE_ROOT),
  };
  const registrationNeedsMigration = syncRegistrationNeedsApiMigration(repoRoot, homeDirectory);
  if (!force && !registrationNeedsMigration && readSyncDrift(driftOptions).fresh) {
    output.write('doompi sync is already up to date\n');
    return 0;
  }

  const progress = new SyncProgress(output);
  const releaseLock = commandOptions.lockHeld
    ? undefined
    : await acquireSyncLocationLock(resolveSyncLocation(repoRoot, homeDirectory));
  let result: SyncResult;
  try {
    // A concurrent publisher may have resolved the drift while this command
    // waited for the lock. Avoid moving the registration for no change.
    const registrationNeedsMigration = syncRegistrationNeedsApiMigration(repoRoot, homeDirectory);
    if (!force && !registrationNeedsMigration && readSyncDrift(driftOptions).fresh) {
      output.write('doompi sync is already up to date\n');
      return 0;
    }
    result = await stageSync(repoRoot, parsed.options, scopedEnvironment, homeDirectory, progress, commandOptions);
  } finally {
    await releaseLock?.();
  }
  emitFrontendHooks(repoRoot, output);
  output.write(formatSyncResult(result, (commandOptions.settingsMode ?? 'persisted') === 'embedded' ? 'dpi' : 'pi'));
  return 0;
}

async function stageSync(
  repoRoot: string,
  options: Omit<HarnessOptions, 'repoRoot'>,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  progress: SyncProgress,
  commandOptions: SyncCommandOptions = {},
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
    const themePath =
      (commandOptions.settingsMode ?? 'persisted') === 'persisted' ? persistedThemePath : context.defaultThemePath;
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

    // Runtime compilation writes the package dist files consumed by both the web
    // and server bundlers. Finish it first so a package clean cannot race either
    // consumer, then run the independent web and server builds together.
    let resolveCompositions!: (compositions: readonly ExtensionComposition[]) => void;
    let rejectCompositions!: (reason?: unknown) => void;
    const compositionsReady = new Promise<readonly ExtensionComposition[]>((resolve, reject) => {
      resolveCompositions = resolve;
      rejectCompositions = reject;
    });
    const runtimeProgress = progress.start(RUNTIME_LABEL, 'precompiling the mode bundles');
    const runtimeBuild = buildSyncedRuntime(location.root, environment, homeDirectory, {
      state,
      directory,
      onCompositionsResolved: resolveCompositions,
    }).then((synced) => {
      runtimeProgress(`${String(Object.keys(synced.bundles).length)} mode bundles`);
      return synced;
    });
    void runtimeBuild.catch(rejectCompositions);
    const webBuild = (async () => {
      await runtimeBuild;
      const webProgress = progress.start(WEB_LABEL, 'bundling the web cockpit plugins');
      const web = await syncWebBundle({
        repoRoot: location.root,
        resolvedEntries: state.resolved,
        environment,
        outputDirectory: path.join(directory, 'web-bundle'),
        onNotice: (message) => progress.line(WEB_LABEL, message),
      });
      if (web.status === 'failed') throw new Error(`Cockpit bundle failed: ${web.reason}`);
      webProgress(web.status === 'bundled' ? `cockpit bundled with plugins: ${web.pluginIds.join(', ')}` : web.reason);
      return web;
    })();
    const serverBuild = (async () => {
      const compositions = await compositionsReady;
      await runtimeBuild;
      const apiProgress = progress.start(API_LABEL, 'compiling the server bundle');
      const apiDirectory = path.join(directory, 'api');
      const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify([...new Set(compositions.map((composition) => composition.fingerprint))]))
        .digest('hex');
      const [server, mcp] = await Promise.all([
        syncServerBundle({
          repositoryRoot: location.root,
          generation,
          fingerprint,
          compositions,
          outputDirectory: apiDirectory,
          cacheDirectory: path.join(directory, 'cache'),
          sharedCacheDirectory: location.sharedCacheDirectory,
        }),
        syncMcpBundle({
          repositoryRoot: location.root,
          generation,
          fingerprint,
          compositions,
          outputDirectory: path.join(directory, 'mcp'),
          cacheDirectory: path.join(directory, 'cache'),
          sharedCacheDirectory: location.sharedCacheDirectory,
        }),
      ]);
      apiProgress(
        `${server.descriptor.entries.length} server facet(s), ${mcp.descriptor.entries.length} MCP plugin(s) compiled`,
      );
      for (const gap of server.contractGaps) progress.line(API_LABEL, `API contract incomplete: ${gap}`);
      return { server, mcp, fingerprint, apiDirectory };
    })();
    const [runtimeResult, webResult, serverResult] = await Promise.allSettled([runtimeBuild, webBuild, serverBuild]);
    if (runtimeResult.status === 'rejected') throw runtimeResult.reason;
    if (webResult.status === 'rejected') throw webResult.reason;
    if (serverResult.status === 'rejected') throw serverResult.reason;
    const synced = runtimeResult.value;
    const web = webResult.value;
    const { server, mcp, fingerprint, apiDirectory } = serverResult.value;
    const descriptorPath = path.join(apiDirectory, DOOM_SERVER_BUNDLE_FILE);
    const mcpDescriptorPath = path.join(directory, 'mcp', DOOM_MCP_BUNDLE_FILE);
    const finalState: SyncState = {
      ...synced.state,
      serverBundle: {
        descriptorPath,
        fingerprint,
        compilerManifests: server.compilerManifests,
        sourcesHash: computeServerSourcesHash(synced.state.resolved),
      },
      mcpBundle: {
        descriptorPath: mcpDescriptorPath,
        fingerprint,
        compilerManifests: mcp.compilerManifests,
        sourcesHash: computeMcpSourcesHash(synced.state.resolved),
      },
    };
    const statePath = await writeSyncState(
      location.root,
      finalState,
      homeDirectory,
      path.join(directory, 'state.json'),
    );
    const projectSettingsPath =
      (commandOptions.settingsMode ?? 'persisted') === 'persisted'
        ? writeProjectPiSettings(location.root, homeDirectory)
        : undefined;
    const result: SyncResult = {
      statePath,
      ...(projectSettingsPath ? { projectSettingsPath } : {}),
      selection,
      mcpServers: synced.state.baseline.mcpConfigPath ? readMcpServerNames(synced.state.baseline.mcpConfigPath) : [],
      skillCount: context.resources.skillCount,
      agentCount: context.resources.agentCount,
    };
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
        apiDirectory,
        serverBundle: { path: descriptorPath, fingerprint, sha256: syncStateSha256(descriptorPath) },
        mcpBundle: { path: mcpDescriptorPath, fingerprint, sha256: syncStateSha256(mcpDescriptorPath) },
        package: packageRegistrationFor(),
      },
      homeDirectory,
    );
    // ponytail: retain generations until host-owned drain evidence can prove no session uses them.
    // Directory age and an open-file check cannot establish that a lazy import is finished.
    return result;
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

/** Compatibility API. Executables call the command function directly. */
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
    return synchronize(args, environment, currentDirectory, output, {
      settingsMode: this.settingsMode,
      homeDirectory: this.homeDirectory,
      lockHeld: this.lockHeld,
    });
  }
}
