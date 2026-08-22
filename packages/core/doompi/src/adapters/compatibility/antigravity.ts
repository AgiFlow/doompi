import fs from 'node:fs';
import path from 'node:path';
import { isRecord, readJson, writeFileAtomic, writeJson } from '../serialization/json';
import type { JsonObject } from '../serialization/json';
import type { CompatibilityContext } from '../compatibilityContext.ts';
import { acquireDirectoryLock, pathInside, runInteractive } from './process.ts';
import {
  AGIFLOW_PROXY_SERVER_NAME,
  ANTIGRAVITY_MCP_PROXY_PACKAGE,
  additionalDirectoryArgs,
  CORE_PLUGIN_NAME,
  MCP_SERVERS_KEY,
  mcpProxyArguments,
  NPX_COMMAND,
  PLUGIN_MANIFEST_FILENAME,
  PLUGINS_DIRECTORY,
  SKILLS_DIRECTORY,
  SKIP_PERMISSIONS_OPTION,
} from './shared.ts';

/**
 * Antigravity state synchronisation.
 *
 * Antigravity reads its configuration from the workspace and from the user's
 * home directory rather than from arguments, so every selection has to be
 * written to disk before launch and reverted when it is no longer selected.
 * Everything the harness writes is tracked in a managed-state file so a file
 * the user created by hand is never silently replaced.
 */

const ANTIGRAVITY_PROVIDER = 'agy';
const AGY_MANAGED_STATE = '.doom-pi-managed.json';
const ANTIGRAVITY_PROXY_SERVER_NAME = 'mcp-proxy';
const PROJECT_MCP_SERVER_NAME = 'project-mcp';
const PENCIL_SERVER_NAME = 'pencil';
const ANTIGRAVITY_SYNC_LOCK = '.doom-pi-sync.lock';
const AGENTS_DIRECTORY = '.agents';
const GENERATED_AGENTS_DIRECTORY = '_agents';
const CODEX_PLUGIN_DIRECTORY = '.codex-plugin';
const MCP_CONFIG_FILENAME = 'mcp_config.json';
const HOOKS_CONFIG_FILENAME = 'hooks.json';
const MANAGED_PLUGINS_KEY = 'plugins';
const MCP_PROXY_TIMEOUT_MS = 1_200_000;
const GEMINI_DIRECTORY = '.gemini';
const ANTIGRAVITY_CLI_DIRECTORY = 'antigravity-cli';
const ANTIGRAVITY_SETTINGS_FILENAME = 'settings.json';
const ANTIGRAVITY_LOCAL_DIRECTORY = '.antigravity-local';
const CLAUDE_DIRECTORY = '.claude';
const DEFAULT_ANTIGRAVITY_MODEL = 'Gemini 3.5 Flash';
const REPO_ROOT_PLACEHOLDER = '$AGY_REPO_ROOT';

/** Rewrites one MCP server definition into the shape Antigravity expects. */
export function adaptAntigravityMcpDefinition(definition: JsonObject, repoRoot: string): JsonObject | undefined {
  if (typeof definition.command === 'string') {
    const adapted: JsonObject = {
      ...definition,
      command: definition.command,
      args: Array.isArray(definition.args) ? definition.args.map(String) : [],
      cwd: typeof definition.cwd === 'string' ? definition.cwd : repoRoot,
    };
    delete adapted.type;
    return adapted;
  }
  const url = typeof definition.url === 'string' ? definition.url : undefined;
  if (!url) return undefined;
  const adapted: JsonObject = { ...definition, serverUrl: url };
  delete adapted.type;
  delete adapted.url;
  return adapted;
}

function syncAntigravityMcp(context: CompatibilityContext): void {
  const repoRoot = context.options.repoRoot;
  const workspacePath = path.join(repoRoot, AGENTS_DIRECTORY, MCP_CONFIG_FILENAME);
  const managedPath = path.join(repoRoot, AGENTS_DIRECTORY, AGY_MANAGED_STATE);
  const workspace = readJson(workspacePath);
  const workspaceMcpServers = workspace[MCP_SERVERS_KEY];
  const workspaceServers = isRecord(workspaceMcpServers) ? { ...workspaceMcpServers } : {};
  const previousManaged = readJson(managedPath);
  const previousMcpServers = previousManaged[MCP_SERVERS_KEY];
  const previousNames = Array.isArray(previousMcpServers) ? previousMcpServers.map(String) : [];
  for (const name of new Set([
    ...previousNames,
    ANTIGRAVITY_PROXY_SERVER_NAME,
    PROJECT_MCP_SERVER_NAME,
    PENCIL_SERVER_NAME,
  ])) {
    delete workspaceServers[name];
  }

  const selectedConfig = readJson(context.mcpConfigPath);
  const selectedMcpServers = selectedConfig[MCP_SERVERS_KEY];
  const selectedServers = isRecord(selectedMcpServers) ? selectedMcpServers : {};
  const allowed = context.mcpAllowlist?.servers;
  const keeps = (name: string): boolean => !allowed || allowed.length === 0 || allowed.includes(name);
  const managedNames: string[] = [];

  if (keeps(AGIFLOW_PROXY_SERVER_NAME)) {
    workspaceServers[ANTIGRAVITY_PROXY_SERVER_NAME] = {
      command: NPX_COMMAND,
      args: mcpProxyArguments(ANTIGRAVITY_MCP_PROXY_PACKAGE, context.proxyConfigPath, true),
      cwd: repoRoot,
      timeout: MCP_PROXY_TIMEOUT_MS,
    };
    managedNames.push(ANTIGRAVITY_PROXY_SERVER_NAME);
  }

  const directNames = context.mcpAllowlist ? (allowed ?? []) : [PROJECT_MCP_SERVER_NAME, PENCIL_SERVER_NAME];
  for (const name of directNames) {
    if (name === AGIFLOW_PROXY_SERVER_NAME) continue;
    const definition = selectedServers[name];
    if (!isRecord(definition)) continue;
    const adapted = adaptAntigravityMcpDefinition(definition, repoRoot);
    if (!adapted) continue;
    workspaceServers[name] = adapted;
    managedNames.push(name);
  }

  writeJson(workspacePath, { ...workspace, [MCP_SERVERS_KEY]: workspaceServers });
  writeJson(managedPath, { ...previousManaged, [MCP_SERVERS_KEY]: managedNames });

  const home = context.environment.HOME;
  if (!home) return;
  // Earlier releases wrote these servers into the Gemini config. Leaving them
  // there would double every tool, so they are removed wherever they are found.
  for (const legacyPath of [
    path.join(home, GEMINI_DIRECTORY, 'config', MCP_CONFIG_FILENAME),
    path.join(home, GEMINI_DIRECTORY, 'config', PLUGINS_DIRECTORY, 'shared', MCP_CONFIG_FILENAME),
  ]) {
    if (!fs.existsSync(legacyPath)) continue;
    const legacy = readJson(legacyPath);
    const legacyMcpServers = legacy[MCP_SERVERS_KEY];
    const servers = isRecord(legacyMcpServers) ? { ...legacyMcpServers } : {};
    for (const name of [
      ANTIGRAVITY_PROXY_SERVER_NAME,
      AGIFLOW_PROXY_SERVER_NAME,
      PROJECT_MCP_SERVER_NAME,
      PENCIL_SERVER_NAME,
    ]) {
      delete servers[name];
    }
    writeJson(legacyPath, { ...legacy, [MCP_SERVERS_KEY]: servers });
  }
}

function antigravitySettingsPath(home: string): string {
  return path.join(home, GEMINI_DIRECTORY, ANTIGRAVITY_CLI_DIRECTORY, ANTIGRAVITY_SETTINGS_FILENAME);
}

function syncAntigravityModel(context: CompatibilityContext): void {
  const home = context.environment.HOME;
  if (!home) throw new Error('HOME is required for Antigravity compatibility');
  const settingsPath = antigravitySettingsPath(home);
  const settings = readJson(settingsPath);
  if (!settings.model) settings.model = context.environment.AGY_MODEL ?? DEFAULT_ANTIGRAVITY_MODEL;
  const trusted = Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces.map(String) : [];
  // Trusting a workspace outlives the run that added it, and this file belongs
  // to Antigravity rather than to DoomPi, so say which file gained the entry.
  if (!trusted.includes(context.options.repoRoot)) {
    trusted.push(context.options.repoRoot);
    process.stderr.write(`[doompi] trusting ${context.options.repoRoot} in ${settingsPath}\n`);
  }
  settings.trustedWorkspaces = trusted;
  writeJson(settingsPath, settings);
}

function ensureManagedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new Error(`Refusing to use unmanaged Antigravity path: ${directory}`);
  }
  if (!stat) fs.mkdirSync(directory, { recursive: true });
}

function replaceManagedSkillLink(linkPath: string, sourcePath: string): void {
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace unmanaged Antigravity path: ${linkPath}`);
    fs.rmSync(linkPath, { force: true });
  }
  fs.symlinkSync(sourcePath, linkPath, 'dir');
}

function syncAntigravityPlugins(context: CompatibilityContext): void {
  const repoRoot = context.options.repoRoot;
  const pluginsRoot = path.join(repoRoot, PLUGINS_DIRECTORY);
  const agentsRoot = path.join(repoRoot, GENERATED_AGENTS_DIRECTORY);
  const targetRoot = path.join(agentsRoot, PLUGINS_DIRECTORY);
  const managedPath = path.join(repoRoot, AGENTS_DIRECTORY, AGY_MANAGED_STATE);
  const managed = readJson(managedPath);
  const previousPlugins = managed[MANAGED_PLUGINS_KEY];
  const previousNames = new Set(Array.isArray(previousPlugins) ? previousPlugins.map(String) : []);
  ensureManagedDirectory(agentsRoot);
  ensureManagedDirectory(targetRoot);
  const selectedNames = new Set<string>();

  for (const plugin of context.plugins) {
    const manifestPath = path.join(plugin.directory, CODEX_PLUGIN_DIRECTORY, PLUGIN_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    const pluginName =
      typeof manifest.name === 'string' && manifest.name ? manifest.name : path.basename(plugin.directory);
    if (
      pluginName === '.' ||
      pluginName === '..' ||
      pluginName.toLowerCase() === CORE_PLUGIN_NAME ||
      pluginName.includes('/') ||
      pluginName.includes('\\')
    ) {
      throw new Error(`Invalid Antigravity plugin name: ${pluginName}`);
    }
    const target = path.join(targetRoot, pluginName);
    selectedNames.add(pluginName);
    ensureManagedDirectory(target);
    writeJson(path.join(target, PLUGIN_MANIFEST_FILENAME), { name: pluginName });
    const skills = path.join(plugin.directory, SKILLS_DIRECTORY);
    const skillsLink = path.join(target, SKILLS_DIRECTORY);
    if (fs.existsSync(skills)) {
      replaceManagedSkillLink(skillsLink, skills);
    } else if (fs.lstatSync(skillsLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.rmSync(skillsLink, { force: true });
    }
  }

  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.name === CORE_PLUGIN_NAME || selectedNames.has(entry.name)) continue;
    const target = path.join(targetRoot, entry.name);
    if (previousNames.has(entry.name)) {
      fs.rmSync(target, { recursive: true, force: true });
      continue;
    }
    if (!entry.isDirectory()) continue;
    // Not in the managed list, but its skills link points into this repository's
    // plugins, so an earlier run created it before the state file existed.
    const skillsLink = path.join(target, SKILLS_DIRECTORY);
    const stat = fs.lstatSync(skillsLink, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) continue;
    const source = path.resolve(path.dirname(skillsLink), fs.readlinkSync(skillsLink));
    if (pathInside(pluginsRoot, source)) fs.rmSync(target, { recursive: true, force: true });
  }

  writeJson(managedPath, { ...managed, [MANAGED_PLUGINS_KEY]: [...selectedNames] });
}

function removeManagedCorePlugin(core: string): void {
  if (readJson(path.join(core, PLUGIN_MANIFEST_FILENAME)).name === CORE_PLUGIN_NAME) {
    fs.rmSync(core, { recursive: true, force: true });
  }
}

function syncAntigravitySharedSkills(context: CompatibilityContext): void {
  const core = path.join(context.options.repoRoot, GENERATED_AGENTS_DIRECTORY, PLUGINS_DIRECTORY, CORE_PLUGIN_NAME);
  const coreStat = fs.lstatSync(core, { throwIfNoEntry: false });
  if (coreStat?.isSymbolicLink()) throw new Error(`Refusing to use unmanaged Antigravity path: ${core}`);
  if (!context.sharedSkills) {
    removeManagedCorePlugin(core);
    return;
  }

  const source = path.join(context.options.repoRoot, CLAUDE_DIRECTORY, SKILLS_DIRECTORY);
  if (!fs.existsSync(source)) {
    removeManagedCorePlugin(core);
    return;
  }
  ensureManagedDirectory(core);
  const target = path.join(core, SKILLS_DIRECTORY);
  ensureManagedDirectory(target);
  writeJson(path.join(core, PLUGIN_MANIFEST_FILENAME), { name: CORE_PLUGIN_NAME });
  const selected = new Set<string>();
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    selected.add(entry.name);
    replaceManagedSkillLink(path.join(target, entry.name), path.join(source, entry.name));
  }
  for (const entry of fs.readdirSync(target)) {
    if (selected.has(entry)) continue;
    const candidate = path.join(target, entry);
    if (fs.lstatSync(candidate).isSymbolicLink()) fs.rmSync(candidate, { force: true });
  }
}

function syncAntigravityHooks(context: CompatibilityContext): void {
  const source = path.join(context.options.repoRoot, ANTIGRAVITY_LOCAL_DIRECTORY, HOOKS_CONFIG_FILENAME);
  const target = path.join(context.options.repoRoot, AGENTS_DIRECTORY, HOOKS_CONFIG_FILENAME);
  const managedPath = path.join(context.options.repoRoot, AGENTS_DIRECTORY, AGY_MANAGED_STATE);
  const managed = readJson(managedPath);
  if (!fs.existsSync(source)) {
    if (managed.hooks === true) fs.rmSync(target, { force: true });
    writeJson(managedPath, { ...managed, hooks: false });
    return;
  }
  const content = fs.readFileSync(source, 'utf8').replaceAll(REPO_ROOT_PLACEHOLDER, context.options.repoRoot);
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStat && managed.hooks !== true) {
    if (!targetStat.isFile() || fs.readFileSync(target, 'utf8') !== content) {
      throw new Error(`Refusing to replace unmanaged Antigravity path: ${target}`);
    }
  }
  writeFileAtomic(target, content);
  writeJson(managedPath, { ...managed, hooks: true });
}

export function antigravityCompatibilityArgs(context: CompatibilityContext): string[] {
  return [
    ...(context.options.skipPermissions ? [SKIP_PERMISSIONS_OPTION] : []),
    ...additionalDirectoryArgs(context),
    ...context.options.providerArgs,
  ];
}

export async function launchAntigravity(context: CompatibilityContext): Promise<number> {
  const home = context.environment.HOME;
  if (!home) throw new Error('HOME is required for Antigravity compatibility');
  // Every step below writes shared state under the user's home directory, so
  // two repositories launching at once have to be serialised.
  const lockPath = path.join(home, GEMINI_DIRECTORY, ANTIGRAVITY_CLI_DIRECTORY, ANTIGRAVITY_SYNC_LOCK);
  const releaseLock = await acquireDirectoryLock(lockPath);
  try {
    syncAntigravityMcp(context);
    syncAntigravityModel(context);
    syncAntigravityPlugins(context);
    syncAntigravitySharedSkills(context);
    syncAntigravityHooks(context);
  } finally {
    await releaseLock();
  }
  return runInteractive(
    ANTIGRAVITY_PROVIDER,
    antigravityCompatibilityArgs(context),
    context.options.repoRoot,
    context.environment,
  );
}
