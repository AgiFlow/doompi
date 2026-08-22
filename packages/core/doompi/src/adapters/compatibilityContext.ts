import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginEntries, resolveSharedSkills } from '@agimon-ai/doompi-config/domains';
import type { DomainMcpAllowlist, PluginEntry } from '@agimon-ai/doompi-config/domains';
import { layerHookGroups, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { PROXY_SERVER_NAME, resolveMcpAllowlist } from '@agimon-ai/doompi-domain/mcp';
import { materializePluginEntries } from '@agimon-ai/doompi-domain/plugins';
import { stageMcpResources } from '@agimon-ai/doompi-domain/resources';
import { applyProfileEnvironment, buildPersonaPrompt, resolveProfile } from '@agimon-ai/doompi-config/profiles';
import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import { projectHarnessEnvironment } from './config/harnessState';
import type { CompatibilityOptions } from '../types/interfaces/compatibility';

type JsonObject = Record<string, unknown>;

const GENERATED_MCP_CONFIG_FILENAME = 'mcp.json';
const PROXY_CONFIG_FILENAME = 'mcp-config.yaml';
const PERSONA_FILENAME = 'persona.md';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const CONFIG_OPTION = '--config';
const TEMPORARY_DIRECTORY_PREFIX = 'doom-pi-compat-';
const ADDITIONAL_DIRS_ENV = 'DOOMPI_ADDITIONAL_DIRS';
const CLAUDE_PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';
const CODEX_REPO_ROOT_ENV = 'CODEX_REPO_ROOT';
const AGY_REPO_ROOT_ENV = 'AGY_REPO_ROOT';
const ORIGINAL_REPO_PATH_ENV = 'ORIGINAL_REPO_PATH';

export interface CompatibilityContext {
  options: CompatibilityOptions;
  environment: NodeJS.ProcessEnv;
  plugins: PluginEntry[];
  profile?: AgentProfile;
  personaFile?: string;
  mcpAllowlist?: DomainMcpAllowlist;
  mcpConfigPath: string;
  proxyConfigPath: string;
  selectedLayers: string[];
  hookGroups: string[];
  sharedSkills: boolean;
  cleanup(): Promise<void>;
}

function resolveProxyConfigPath(config: JsonObject, repoRoot: string): string {
  const servers = (config.mcpServers ?? {}) as Record<string, JsonObject>;
  const proxy = servers[PROXY_SERVER_NAME];
  const args = Array.isArray(proxy?.args) ? proxy.args.map(String) : [];
  const configIndex = args.indexOf(CONFIG_OPTION);
  const selected = configIndex === -1 ? undefined : args[configIndex + 1];
  return selected ? path.resolve(repoRoot, selected) : path.join(repoRoot, PROXY_CONFIG_FILENAME);
}

async function writeCompatibilityMcpConfig(
  repoRoot: string,
  plugins: PluginEntry[],
  allowlist: DomainMcpAllowlist | undefined,
  temporaryDirectory: string,
): Promise<{ mcpConfigPath: string; proxyConfigPath: string }> {
  const resources = await stageMcpResources(repoRoot, plugins, {
    enabled: true,
    temporaryDirectory,
    ...(allowlist ? { mcpAllowlist: allowlist } : {}),
  });
  const mcpConfigPath = resources.mcpConfigPath ?? path.join(temporaryDirectory, GENERATED_MCP_CONFIG_FILENAME);
  const config = JSON.parse(await fs.promises.readFile(mcpConfigPath, 'utf8')) as JsonObject;
  return { mcpConfigPath, proxyConfigPath: resolveProxyConfigPath(config, repoRoot) };
}

/** Resolves only the resources shared by Pi and compatibility frontends. */
export async function buildCompatibilityContext(options: CompatibilityOptions): Promise<CompatibilityContext> {
  const majorModesConfig = loadMajorModesConfig(options.repoRoot);
  const selectedLayers = resolveLayers(majorModesConfig, options.majorMode);
  const hookGroups = layerHookGroups(majorModesConfig, selectedLayers);
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
  await fs.promises.chmod(temporaryDirectory, PRIVATE_DIRECTORY_MODE);

  try {
    const profile = options.profile ? resolveProfile(options.repoRoot, options.profile) : undefined;
    const plugins = await materializePluginEntries(resolvePluginEntries(options.repoRoot, options.domains, []));
    const mcpAllowlist = resolveMcpAllowlist(options.repoRoot, options.domains);
    const mcp = await writeCompatibilityMcpConfig(options.repoRoot, plugins, mcpAllowlist, temporaryDirectory);
    const environment = { ...process.env };
    environment.NX_DAEMON ??= 'false';
    const profileEnvironment = applyProfileEnvironment(environment, profile?.env ?? {});
    const personaPrompt = profile?.persona ? buildPersonaPrompt(profile.personaRoot, profile.persona) : undefined;
    let personaFile: string | undefined;

    if (personaPrompt) {
      personaFile = path.join(temporaryDirectory, PERSONA_FILENAME);
      await fs.promises.writeFile(personaFile, `${personaPrompt}\n`, { mode: PRIVATE_FILE_MODE });
    }

    // Projection only, with no state file: Claude, Codex and Antigravity read
    // an environment and never the store.
    projectHarnessEnvironment(
      {
        root: options.repoRoot,
        majorMode: options.majorMode,
        temporaryDirectory,
        domains: options.domains,
        layers: selectedLayers,
        profile: profile?.name,
        profileEnvironment,
        hookGroups,
        mcpConfigPath: mcp.mcpConfigPath,
        personaFile,
        additionalDirectories: options.additionalDirectories,
        hooks: true,
      },
      environment,
    );
    environment[ADDITIONAL_DIRS_ENV] = options.additionalDirectories.join(path.delimiter);
    environment[CLAUDE_PROJECT_DIR_ENV] = options.repoRoot;
    environment[CODEX_REPO_ROOT_ENV] = options.repoRoot;
    environment[AGY_REPO_ROOT_ENV] = options.repoRoot;
    environment[ORIGINAL_REPO_PATH_ENV] ||= options.repoRoot;

    return {
      options,
      environment,
      plugins,
      profile,
      personaFile,
      mcpAllowlist,
      mcpConfigPath: mcp.mcpConfigPath,
      proxyConfigPath: mcp.proxyConfigPath,
      selectedLayers,
      hookGroups,
      sharedSkills: resolveSharedSkills(options.repoRoot, options.domains),
      cleanup: () => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
