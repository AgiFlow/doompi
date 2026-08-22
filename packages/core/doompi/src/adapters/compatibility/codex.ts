import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JsonObject } from '../serialization/json';
import type { CompatibilityContext } from '../compatibilityContext.ts';
import { runCaptured, runChecked, runInteractive } from './process.ts';
import {
  ADD_DIRECTORY_OPTION,
  AGIFLOW_PROXY_SERVER_NAME,
  additionalDirectoryArgs,
  MCP_CONFIG_OPTION,
  MCP_PRESTART_OPTION,
  MCP_PROXY_PACKAGE,
  mcpProxyArguments,
  NPX_COMMAND,
  PLUGINS_DIRECTORY,
} from './shared.ts';

export const CODEX_PROVIDER = 'codex';

const PROFILE_FLAG = '--profile';
const PROFILE_V2_FLAG = '--profile-v2';
const PROFILE_CONFIG_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SYNC_SCRIPT_RELATIVE_PATH = ['tools', 'harness', 'sync-codex-state.cjs'];

/** Codex options that consume the following argument, so it is not a subcommand. */
function optionRequiresValue(argument: string): boolean {
  return new Set([
    PROFILE_FLAG,
    PROFILE_V2_FLAG,
    '-c',
    MCP_CONFIG_OPTION,
    '--enable',
    '--disable',
    '--remote',
    '--remote-auth-token-env',
    '-i',
    '--image',
    '-m',
    '--model',
    '--local-provider',
    '-s',
    '--sandbox',
    '-C',
    '--cd',
    ADD_DIRECTORY_OPTION,
    '-a',
    '--ask-for-approval',
  ]).has(argument);
}

/**
 * Whether the managed profile, persona, and proxy config apply to this run.
 *
 * Codex management subcommands reject session options, so injecting them would
 * turn `codex login` into an error.
 */
export function supportsCodexManagedProfile(args: string[]): boolean {
  let previousRequiresValue = false;
  let command = '';
  let debugSubcommand = '';

  for (const argument of args) {
    if (previousRequiresValue) {
      previousRequiresValue = false;
      continue;
    }
    if (optionRequiresValue(argument)) {
      previousRequiresValue = true;
      continue;
    }
    if (argument.startsWith('-')) continue;
    if (!command) {
      command = argument;
      continue;
    }
    if (command === 'debug' && !debugSubcommand) debugSubcommand = argument;
    break;
  }

  if (!command || ['exec', 'e', 'review', 'resume', 'fork'].includes(command)) return true;
  if (command === 'debug') return debugSubcommand === 'prompt-input';
  if (
    [
      'login',
      'logout',
      'mcp',
      'plugin',
      'mcp-server',
      'app-server',
      'remote-control',
      'app',
      'completion',
      'update',
      'doctor',
      'sandbox',
      'apply',
      'a',
      'cloud',
      'exec-server',
      'features',
      'archive',
      'delete',
      'unarchive',
      'help',
    ].includes(command)
  ) {
    return false;
  }
  return true;
}

/** Plugin directory names relative to `plugins/`, which is all Codex accepts. */
export function codexPluginDirectories(context: CompatibilityContext): string[] {
  const pluginsRoot = path.join(context.options.repoRoot, PLUGINS_DIRECTORY);
  return context.plugins.map((plugin) => {
    const relative = path.relative(pluginsRoot, plugin.directory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || relative.includes(path.sep)) {
      throw new Error(`Codex compatibility requires a direct repository plugin: ${plugin.directory}`);
    }
    return relative;
  });
}

/** Codex's full-auto mode: no approval prompts and no sandbox. */
const YOLO_OPTION = '--yolo';

function codexProxyArguments(context: CompatibilityContext): string[] {
  return mcpProxyArguments(MCP_PROXY_PACKAGE, context.proxyConfigPath, true, true);
}

export function codexCompatibilityArgs(
  context: CompatibilityContext,
  managedProfileName: string,
  managedProfileFlag: string,
): string[] {
  const args = [
    ...(context.options.skipPermissions ? [YOLO_OPTION] : []),
    '--enable',
    'hooks',
    ...additionalDirectoryArgs(context),
  ];
  if (supportsCodexManagedProfile(context.options.providerArgs)) {
    args.push(managedProfileFlag, managedProfileName);
    if (context.personaFile) {
      const persona = fs.readFileSync(context.personaFile, 'utf8');
      args.push('-c', `developer_instructions=${JSON.stringify(persona)}`);
    }
    if (context.mcpAllowlist) {
      args.push('-c', `mcp_servers.${AGIFLOW_PROXY_SERVER_NAME}.args=${JSON.stringify(codexProxyArguments(context))}`);
    }
  }
  return [...args, ...context.options.providerArgs];
}

export function codexEnvironment(context: CompatibilityContext): NodeJS.ProcessEnv {
  const environment = { ...context.environment };
  const originResult = spawnSync('git', ['-C', context.options.repoRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    env: environment,
  });
  environment.CODEX_REPO_ORIGIN = originResult.status === 0 ? originResult.stdout.trim() : '';
  environment.CODEX_PROFILE_NAMES = context.options.domains.join(',');
  environment.CODEX_PLUGIN_DIRS = codexPluginDirectories(context).join(',');
  environment.CODEX_ENABLE_XCODE_MCP =
    spawnSync('xcrun', ['mcpbridge', '--help'], { env: environment, stdio: 'ignore' }).status === 0 ? '1' : '0';
  return environment;
}

export async function launchCodex(context: CompatibilityContext): Promise<number> {
  const environment = codexEnvironment(context);
  const syncScript = path.join(context.options.repoRoot, ...SYNC_SCRIPT_RELATIVE_PATH);
  const stateName = runCaptured(process.execPath, [syncScript, 'owner-key'], context.options.repoRoot, environment);
  const home = environment.HOME;
  environment.CODEX_LEGACY_HOME = home ? path.join(home, '.codex', 'agirepo') : undefined;
  environment.CODEX_HOME = home
    ? path.join(home, '.codex', stateName)
    : path.join(context.options.repoRoot, '.codex-local', 'state', stateName);

  runChecked(
    NPX_COMMAND,
    [...mcpProxyArguments(MCP_PROXY_PACKAGE, context.proxyConfigPath, true), MCP_PRESTART_OPTION],
    context.options.repoRoot,
    environment,
  );

  const syncOutput = runCaptured(process.execPath, [syncScript, 'sync'], context.options.repoRoot, environment);
  const syncResult = JSON.parse(syncOutput) as JsonObject;
  if (
    typeof syncResult.profileConfigName !== 'string' ||
    !PROFILE_CONFIG_NAME_PATTERN.test(syncResult.profileConfigName)
  ) {
    throw new Error('Codex sync returned an invalid profile config name');
  }
  // Older Codex builds only understand --profile, so the flag is probed rather
  // than assumed.
  const help = runCaptured(CODEX_PROVIDER, ['--help'], context.options.repoRoot, environment);
  const profileFlag = help.includes(PROFILE_V2_FLAG) ? PROFILE_V2_FLAG : PROFILE_FLAG;
  return runInteractive(
    CODEX_PROVIDER,
    codexCompatibilityArgs(context, syncResult.profileConfigName, profileFlag),
    context.options.repoRoot,
    environment,
  );
}
