import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { resolveMcpAllowlist } from '@agimon-ai/doompi-domain/mcp';
import { materializePluginEntries } from '@agimon-ai/doompi-domain/plugins';
import { collectResources, type HarnessResources } from '@agimon-ai/doompi-domain/resources';
import {
  createHarnessTelemetry,
  HARNESS_EVENT,
  type HarnessTelemetry,
} from '../adapters/telemetry/logSinkTelemetry.ts';
import { resolvePluginEntries, resolveSharedSkills } from '@agimon-ai/doompi-config/domains';
import type { DomainMcpAllowlist, PluginEntry } from '@agimon-ai/doompi-config/domains';
import {
  filterHookDisabledLayers,
  layerHookGroups,
  loadMajorModesConfig,
  resolveLayers,
} from '@agimon-ai/doompi-config/majorModes';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { applyProfileEnvironment, buildPersonaPrompt, resolveProfile } from '@agimon-ai/doompi-config/profiles';
import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import { DOOM_CORDIS_HOST_REQUIRED_ENV } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_MCP_SESSION_ENV_VAR } from '@agimon-ai/doompi-extension-contracts/mcp-session';
import { DEFAULT_THEME_NAME, writeDefaultTheme } from '@agimon-ai/doompi-ui/theme';
import { createHarnessSession } from './config/harnessState';
import { PERSONA_ENTRY } from '../services/extensionAssembler.ts';
import type { HarnessOptions } from '../types/interfaces/harness';
import { packageEntry } from './modules/moduleResolution';
import { resolveSyncLocation } from './syncLocation.ts';

const OLLAMA_PRESET = 'ollama';
const PRIVATE_FILE_MODE = 0o600;
const RESOLVE_CONFIG_PHASE = 'resolve_config';
const COLLECT_RESOURCES_PHASE = 'collect_resources';
const BUILD_CONTEXT_PHASE = 'build_context';

/**
 * Everything a command needs, resolved once.
 *
 * All three commands need the same expensive preparation (domains resolved,
 * plugins collected into a temp directory, environment assembled), so it is
 * built here and handed to whichever command runs.
 */
export interface HarnessContext {
  options: HarnessOptions;
  environment: NodeJS.ProcessEnv;
  resources: HarnessResources;
  plugins: PluginEntry[];
  profile?: string;
  personaDirectory?: string;
  /** Root personaDirectory resolves against, when a profile supplied one. */
  personaRoot?: string;
  mcpAllowlist?: DomainMcpAllowlist;
  majorModesConfig: MajorModesConfig;
  selectedLayers: string[];
  hookGroups: string[];
  personaEntry?: string;
  defaultThemePath: string;
  cleanup(): Promise<void>;
}

/**
 * Applies the provider environment a preset needs.
 *
 * Exported because the synced Pi path has no launcher to do it: the doom-pi
 * extension applies the same rules in-process before anything reads them.
 * `piArgs` is only consulted to spot a selected cloud model.
 */
export function configurePreset(
  options: Pick<HarnessOptions, 'preset' | 'piArgs'>,
  environment: NodeJS.ProcessEnv,
): void {
  if (options.preset === 'kimi') {
    if (!environment.KIMI_API_KEY && environment.KIMI_CODE_API_KEY) {
      environment.KIMI_API_KEY = environment.KIMI_CODE_API_KEY;
    }
    if (!environment.KIMI_API_KEY) {
      throw new Error('KIMI_API_KEY or KIMI_CODE_API_KEY is required for the kimi preset');
    }
  }
  if (options.preset === OLLAMA_PRESET) {
    const selected = options.piArgs.find((argument) => argument.startsWith(`${OLLAMA_PRESET}/`));
    const cloud = selected?.endsWith(':cloud') ?? false;
    if (cloud && !environment.OLLAMA_API_KEY) {
      throw new Error('OLLAMA_API_KEY is required for Ollama cloud models');
    }
    environment.OLLAMA_API_KEY ||= OLLAMA_PRESET;
    environment.DOOMPI_OLLAMA_BASE_URL =
      environment.OLLAMA_BASE_URL ?? environment.ANTHROPIC_BASE_URL ?? 'http://localhost:11434/v1';
  }
}

/** Resolves the optional persona and environment profile selected for this run. */
export function resolveHarnessProfile(options: HarnessOptions): AgentProfile | undefined {
  return options.profile ? resolveProfile(options.repoRoot, options.profile) : undefined;
}

/**
 * Resolves the full matrix and stages every resource Pi will need.
 *
 * The caller owns the returned cleanup(): the temporary directory holding
 * skills, agents, and the generated MCP config has to outlive this function
 * and be removed once the selected command is done with it.
 */
export async function buildHarnessContext(
  options: HarnessOptions,
  telemetry: HarnessTelemetry = createHarnessTelemetry(),
): Promise<HarnessContext> {
  // Everything up to collectResources reads configuration off disk, so a single
  // malformed modes.yaml or profiles.yaml surfaces here as a failed launch
  // with no other record.
  const configured = await telemetry
    .runInSpan(`doom_pi.${RESOLVE_CONFIG_PHASE}`, { 'harness.phase': RESOLVE_CONFIG_PHASE }, async () => {
      const majorModesConfig = loadMajorModesConfig(options.repoRoot, options.homeDirectory);
      const selectedLayers = filterHookDisabledLayers(
        majorModesConfig,
        resolveLayers(majorModesConfig, options.majorMode),
        options.hooks,
      );
      const profile = resolveHarnessProfile(options);
      if (!fs.existsSync(options.cwd) || !fs.statSync(options.cwd).isDirectory()) {
        throw new Error(`Working directory does not exist: ${options.cwd}`);
      }
      return {
        majorModesConfig,
        selectedLayers,
        hookGroups: layerHookGroups(majorModesConfig, selectedLayers),
        profile,
        plugins: await materializePluginEntries(
          resolvePluginEntries(options.repoRoot, options.domains, options.pluginDirectories),
        ),
        mcpAllowlist: resolveMcpAllowlist(options.repoRoot, options.domains),
        sharedSkills: resolveSharedSkills(options.repoRoot, options.domains),
      };
    })
    .catch(async (error: unknown) => {
      await telemetry.recordError(HARNESS_EVENT.configLoadFailed, error, {
        'harness.phase': RESOLVE_CONFIG_PHASE,
        'harness.major_mode': options.majorMode,
        'harness.domain_count': options.domains.length,
      });
      throw error;
    });

  const { majorModesConfig, selectedLayers, hookGroups, profile, plugins, mcpAllowlist } = configured;
  const personaDirectory = profile?.persona;
  // A global profile's persona lives beside the global config, not in the repo.
  const personaRoot = profile?.personaRoot ?? options.repoRoot;
  const resources = await telemetry
    .runInSpan(
      `doom_pi.${COLLECT_RESOURCES_PHASE}`,
      { 'harness.plugin.count': plugins.length, 'harness.agents': options.agents, 'harness.mcp': options.mcp },
      () =>
        collectResources(options.repoRoot, plugins, {
          agents: options.agents,
          mcp: options.mcp,
          // Set by `doom-pi sync`, which stages into a directory that outlives
          // the process rather than a temporary one.
          temporaryDirectory: options.resourceDirectory,
          skillCacheDirectory: path.join(
            options.resourceDirectory ??
              resolveSyncLocation(options.repoRoot, options.homeDirectory ?? os.homedir()).directory,
            'cache',
            'skills',
          ),
          mcpAllowlist,
          sharedSkills: configured.sharedSkills,
          pluginDataRoot: path.join(globalDoomConfigDirectory(options.homeDirectory ?? os.homedir()), 'plugin-data'),
        }),
    )
    .catch(async (error: unknown) => {
      // Conflicting skills, agents, or MCP servers all fail here, and the plugin
      // that caused it is only identifiable from the message.
      await telemetry.recordError(HARNESS_EVENT.resourceCollectionFailed, error, {
        'harness.phase': COLLECT_RESOURCES_PHASE,
        'harness.plugin.count': plugins.length,
      });
      throw error;
    });

  try {
    const defaultThemePath = await writeDefaultTheme(resources.temporaryDirectory);
    const environment = { ...process.env };
    // The file-backed projection published through Cordis is authoritative.
    // Never let a legacy parent-process projection leak into this Doom session.
    delete environment[DOOM_MCP_SESSION_ENV_VAR];
    const profileEnvironment = applyProfileEnvironment(environment, profile?.env ?? {});

    configurePreset(options, environment);
    environment.NX_DAEMON ??= 'false';
    environment[DOOM_CORDIS_HOST_REQUIRED_ENV] = '1';
    environment.DOOMPI_THEME ||= DEFAULT_THEME_NAME;
    environment.CLAUDE_PROJECT_DIR = options.repoRoot;
    environment.CODEX_REPO_ROOT = options.repoRoot;
    environment.ORIGINAL_REPO_PATH ||= options.repoRoot;
    environment.MCP_UI_VIEWER = options.automation ? 'none' : (environment.MCP_UI_VIEWER ?? '');

    // Always loaded, even with no persona at launch: the extension no-ops
    // without a persona file, and /profile needs it present to load one later.
    // Pi freezes the --extension list at startup, so it cannot be added on demand.
    const personaEntry = packageEntry(PERSONA_ENTRY);
    const personaPrompt = personaDirectory ? buildPersonaPrompt(personaRoot, personaDirectory) : undefined;
    let personaFile: string | undefined;
    if (personaPrompt) {
      personaFile = path.join(resources.temporaryDirectory, 'persona.md');
      await fs.promises.writeFile(personaFile, `${personaPrompt}\n`, { mode: PRIVATE_FILE_MODE });
    }

    // One write, describing the child rather than this process. The state file
    // is the child's authority and the environment is what it projects for the
    // hooks and packages that can only read an environment.
    createHarnessSession(
      {
        root: options.repoRoot,
        majorMode: options.majorMode,
        temporaryDirectory: resources.temporaryDirectory,
        domains: options.domains,
        layers: selectedLayers,
        profile: profile?.name,
        profileEnvironment,
        personaFile,
        skillDirectories: resources.skillDirectories,
        agentDirectories: resources.agentDirectories,
        additionalDirectories: options.additionalDirectories,
        childExtensions: [],
        pluginDirectories: options.pluginDirectories,
        pluginHooks: resources.pluginHooks,
        hookGroups,
        hooks: options.hooks,
        agents: options.agents,
        mcp: options.mcp,
        mcpConfigPath: resources.mcpConfigPath,
        mcpProjection: resources.mcpProjection,
        allowProtectedWrites: options.allowProtectedWrites,
      },
      { directory: resources.temporaryDirectory, environment },
    );
    if (options.agents) {
      environment.PI_SUBAGENT_EXTRA_AGENT_DIRS = resources.agentDirectories.join(path.delimiter);
      environment.PI_SUBAGENT_EXTRA_SKILL_DIRS = resources.skillDirectories.join(path.delimiter);
      environment.PI_SUBAGENT_PI_BINARY = path.join(options.repoRoot, 'pi.sh');
    }

    // Core hook groups load regardless; hookGroups selects the rest. The initial
    // state write includes an empty list deliberately: unset means every group.

    return {
      options,
      environment,
      resources,
      plugins,
      profile: profile?.name,
      personaDirectory,
      personaRoot,
      mcpAllowlist,
      majorModesConfig,
      selectedLayers,
      hookGroups,
      personaEntry,
      defaultThemePath,
      cleanup: resources.cleanup.bind(resources),
    };
  } catch (error) {
    // Preparation failed after the temp directory existed, so nothing will be
    // handed back to clean it up.
    await telemetry.recordError(HARNESS_EVENT.contextBuildFailed, error, {
      'harness.phase': BUILD_CONTEXT_PHASE,
      'harness.major_mode': options.majorMode,
      ...(profile?.name ? { 'harness.profile': profile.name } : {}),
    });
    await resources.cleanup();
    throw error;
  }
}
