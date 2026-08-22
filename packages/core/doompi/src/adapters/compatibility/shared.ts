import type { CompatibilityContext } from '../compatibilityContext.ts';

/**
 * Values and argument builders shared by more than one provider.
 *
 * Kept separate from index.ts so the provider modules can import them without
 * depending on the dispatch that imports the provider modules.
 */

/**
 * Pinned, not `@latest`.
 *
 * These launches run `npx -y`, so a floating tag installs and executes whatever
 * was published most recently on the user's machine, with no lockfile in the
 * way. The version tracks the coordinated `@agimon-ai` release train recorded
 * in pnpm-workspace.yaml's minimumReleaseAgeExclude list; bump both together.
 */
export const MCP_PROXY_VERSION = '0.31.16';
export const MCP_PROXY_PACKAGE = `@agimon-ai/mcp-proxy@${MCP_PROXY_VERSION}`;
export const ANTIGRAVITY_MCP_PROXY_PACKAGE = `@agimon-ai/mcp-proxy@${MCP_PROXY_VERSION}`;
export const AGIFLOW_PROXY_SERVER_NAME = 'agiflow-proxy';
export const MCP_CONFIG_OPTION = '--config';
export const MCP_PRESTART_OPTION = '--prestart-http';
export const ADD_DIRECTORY_OPTION = '--add-dir';
export const SKIP_PERMISSIONS_OPTION = '--dangerously-skip-permissions';
export const NPX_COMMAND = 'npx';
export const PLUGINS_DIRECTORY = 'plugins';
export const SKILLS_DIRECTORY = 'skills';
export const MCP_SERVERS_KEY = 'mcpServers';
export const CORE_PLUGIN_NAME = 'core';
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json';

const MCP_SERVE_COMMAND = 'mcp-serve';
const MCP_TYPE_OPTION = '--type';
const MCP_STDIO_HTTP_TYPE = 'stdio-http';
const MCP_PROXY_MODE_OPTION = '--proxy-mode';
const MCP_PROXY_MODE = 'flat';
const MCP_PROXY_MODE_ASSIGNMENT = `${MCP_PROXY_MODE_OPTION}=${MCP_PROXY_MODE}`;
const NPX_ASSUME_YES_OPTION = '-y';

/**
 * Command line for the MCP proxy.
 *
 * `inlineProxyMode` picks `--proxy-mode=flat` over `--proxy-mode flat`, which
 * Codex needs because it receives the whole argument vector as one `-c` value.
 */
export function mcpProxyArguments(
  packageName: string,
  configPath: string,
  assumeYes: boolean,
  inlineProxyMode = false,
): string[] {
  return [
    ...(assumeYes ? [NPX_ASSUME_YES_OPTION] : []),
    packageName,
    MCP_SERVE_COMMAND,
    MCP_TYPE_OPTION,
    MCP_STDIO_HTTP_TYPE,
    ...(inlineProxyMode ? [MCP_PROXY_MODE_ASSIGNMENT] : [MCP_PROXY_MODE_OPTION, MCP_PROXY_MODE]),
    MCP_CONFIG_OPTION,
    configPath,
  ];
}

export function additionalDirectoryArgs(context: CompatibilityContext): string[] {
  return context.options.additionalDirectories.flatMap((directory) => [ADD_DIRECTORY_OPTION, directory]);
}
