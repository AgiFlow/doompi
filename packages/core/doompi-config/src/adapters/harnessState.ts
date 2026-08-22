import path from 'node:path';
import type { HarnessState, PluginHookSource } from '../types/config.ts';

/**
 * The codec between harness state and the environment.
 *
 * Decoding exists for processes that were started without a state file: a
 * nested run, a third-party spawn, or anything older than the store. Encoding
 * exists because bash hooks, the shell launchers, and packages that do not
 * depend on this one can only read an environment. Ownership, persistence and
 * mutation belong to harnessStore.ts; nothing here touches disk or holds state.
 */

const DEFAULT_MAJOR_MODE = 'copilot';
const DISABLED_FLAG = '0';

/**
 * State that lives in the file only.
 *
 * These are JSON documents that every spawned process and every hook would
 * otherwise copy in its environment. The plugin hook list and profile defaults
 * are read from the store, while Config publishes the MCP projection through
 * the session-scoped Cordis registry.
 */
export const FILE_ONLY_STATE_FIELDS: ReadonlySet<keyof HarnessState> = new Set([
  'profileEnvironment',
  'pluginHooks',
  'mcpProjection',
]);

export type HarnessStateParseReporter = (key: string, error: unknown) => void;

export const HARNESS_STATE_KEYS = {
  root: 'DOOMPI_ROOT',
  majorMode: 'DOOMPI_MAJOR_MODE',
  temporaryDirectory: 'DOOMPI_TEMP_DIR',
  domains: 'DOOMPI_DOMAINS',
  layers: 'DOOMPI_LAYERS',
  compositionFingerprint: 'DOOMPI_COMPOSITION_FINGERPRINT',
  profile: 'DOOMPI_PROFILE',
  profileEnvironment: 'DOOMPI_PROFILE_ENV',
  hookGroups: 'DOOMPI_HOOK_GROUPS',
  skillDirectories: 'DOOMPI_SKILL_DIRS',
  agentDirectories: 'DOOMPI_AGENT_DIRS',
  additionalDirectories: 'DOOMPI_ADDITIONAL_DIRS',
  childExtensions: 'DOOMPI_CHILD_EXTENSIONS',
  pluginDirectories: 'DOOMPI_PLUGIN_DIRS',
  pluginHooks: 'DOOMPI_PLUGIN_HOOKS',
  mcpConfigPath: 'DOOMPI_MCP_CONFIG',
  personaFile: 'DOOMPI_PERSONA_FILE',
  hooks: 'DOOMPI_HOOKS_ENABLED',
  agents: 'DOOMPI_AGENTS_ENABLED',
  mcp: 'DOOMPI_MCP_ENABLED',
  allowProtectedWrites: 'DOOMPI_ALLOW_PROTECTED_WRITES',
} as const;

function splitCsv(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function splitPaths(value: string | undefined): string[] {
  return (
    value
      ?.split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function parseFlag(value: string | undefined): boolean {
  return value !== DISABLED_FLAG;
}

function parseStringRecord(
  value: string | undefined,
  key: string,
  report?: HarnessStateParseReporter,
): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch (error) {
    report?.(key, error);
    return {};
  }
}

function parseStringList(value: string | undefined, key: string, report?: HarnessStateParseReporter): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch (error) {
    report?.(key, error);
    return [];
  }
}

function parsePluginHooks(
  value: string | undefined,
  key: string,
  report?: HarnessStateParseReporter,
): PluginHookSource[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PluginHookSource =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as PluginHookSource).pluginRoot === 'string' &&
        typeof (item as PluginHookSource).configPath === 'string',
    );
  } catch (error) {
    report?.(key, error);
    return [];
  }
}

export function readHarnessState(
  environment: NodeJS.ProcessEnv = process.env,
  report?: HarnessStateParseReporter,
): HarnessState {
  const keys = HARNESS_STATE_KEYS;
  const hookGroups = environment[keys.hookGroups];
  return {
    root: environment[keys.root] || undefined,
    majorMode: environment[keys.majorMode] || DEFAULT_MAJOR_MODE,
    temporaryDirectory: environment[keys.temporaryDirectory] || undefined,
    domains: splitCsv(environment[keys.domains]),
    layers: splitCsv(environment[keys.layers]),
    compositionFingerprint: environment[keys.compositionFingerprint] || undefined,
    profile: environment[keys.profile] || undefined,
    profileEnvironment: parseStringRecord(environment[keys.profileEnvironment], keys.profileEnvironment, report),
    hookGroups: hookGroups === undefined ? undefined : splitCsv(hookGroups),
    skillDirectories: splitPaths(environment[keys.skillDirectories]),
    agentDirectories: splitPaths(environment[keys.agentDirectories]),
    additionalDirectories: splitPaths(environment[keys.additionalDirectories]),
    childExtensions: parseStringList(environment[keys.childExtensions], keys.childExtensions, report),
    pluginDirectories: splitPaths(environment[keys.pluginDirectories]),
    pluginHooks: parsePluginHooks(environment[keys.pluginHooks], keys.pluginHooks, report),
    mcpConfigPath: environment[keys.mcpConfigPath] || undefined,
    personaFile: environment[keys.personaFile] || undefined,
    hooks: parseFlag(environment[keys.hooks]),
    agents: parseFlag(environment[keys.agents]),
    mcp: parseFlag(environment[keys.mcp]),
    allowProtectedWrites: parseFlag(environment[keys.allowProtectedWrites]),
  };
}

/**
 * Publishes a state patch into an environment.
 *
 * Takes the environment rather than assuming `process.env`, because the
 * launcher builds a child environment and Doom Team builds a spawn snapshot;
 * neither should mutate its own process to describe another one.
 *
 * Fields in FILE_ONLY_FIELDS are skipped: the file carries them, and a reader
 * that needs them reads the store.
 */
export function projectHarnessEnvironment(
  patch: Partial<HarnessState>,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const assign = (key: string, value: string | undefined): void => {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  };
  const assignFlag = (key: string, value: boolean): void => assign(key, value ? '1' : DISABLED_FLAG);
  const keys = HARNESS_STATE_KEYS;

  if ('root' in patch) assign(keys.root, patch.root);
  if ('majorMode' in patch) assign(keys.majorMode, patch.majorMode);
  if ('temporaryDirectory' in patch) assign(keys.temporaryDirectory, patch.temporaryDirectory);
  if ('domains' in patch) assign(keys.domains, patch.domains?.join(','));
  if ('layers' in patch) assign(keys.layers, patch.layers?.join(','));
  if ('compositionFingerprint' in patch) assign(keys.compositionFingerprint, patch.compositionFingerprint);
  if ('profile' in patch) assign(keys.profile, patch.profile);
  if ('hookGroups' in patch) assign(keys.hookGroups, patch.hookGroups?.join(','));
  if ('skillDirectories' in patch) assign(keys.skillDirectories, patch.skillDirectories?.join(path.delimiter));
  if ('agentDirectories' in patch) assign(keys.agentDirectories, patch.agentDirectories?.join(path.delimiter));
  if ('additionalDirectories' in patch) {
    assign(keys.additionalDirectories, patch.additionalDirectories?.join(path.delimiter));
  }
  if ('childExtensions' in patch) assign(keys.childExtensions, JSON.stringify(patch.childExtensions ?? []));
  if ('pluginDirectories' in patch) assign(keys.pluginDirectories, patch.pluginDirectories?.join(path.delimiter));
  if ('mcpConfigPath' in patch) assign(keys.mcpConfigPath, patch.mcpConfigPath);
  if ('personaFile' in patch) assign(keys.personaFile, patch.personaFile);
  if (patch.hooks !== undefined) assignFlag(keys.hooks, patch.hooks);
  if (patch.agents !== undefined) assignFlag(keys.agents, patch.agents);
  if (patch.mcp !== undefined) assignFlag(keys.mcp, patch.mcp);
  if (patch.allowProtectedWrites !== undefined) assignFlag(keys.allowProtectedWrites, patch.allowProtectedWrites);
  return environment;
}
