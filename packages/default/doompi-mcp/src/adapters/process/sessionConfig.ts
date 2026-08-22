import os from 'node:os';
import path from 'node:path';
import {
  DOOM_MCP_SESSION_ENV_VAR,
  doomMcpSessionEnvironment,
  readDoomMcpSessionConfig,
} from '@agimon-ai/doompi-extension-contracts/mcp-session';
import type { McpAllowlist, McpSessionConfig } from '../../types/mcpConfig.ts';

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function readAllowlist(value: unknown): McpAllowlist | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { servers, proxy } = value as { servers?: unknown; proxy?: unknown };
  const allowlist: McpAllowlist = {};
  const allowedServers = asStringArray(servers);
  const allowedProxy = asStringArray(proxy);
  if (allowedServers) allowlist.servers = allowedServers;
  if (allowedProxy) allowlist.proxy = allowedProxy;
  return allowlist.servers || allowlist.proxy ? allowlist : undefined;
}

/**
 * Resolves what this session should connect to.
 *
 * Every field falls back to a working default so the extension is usable outside
 * doom-pi: a bare Pi session in a repository still gets that repository's
 * `.mcp.json` with no allowlist. A malformed value is treated as absent rather
 * than fatal, because losing MCP is better than losing the session.
 */
export function readSessionConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultRepoRoot: string = process.cwd(),
): McpSessionConfig {
  const fallback: McpSessionConfig = {
    repoRoot: defaultRepoRoot,
    stagingDirectory: path.join(os.tmpdir(), 'doom-mcp'),
  };

  const strict = readDoomMcpSessionConfig(env);
  if (strict) {
    const { allowlist, pluginConfigPaths, ...required } = strict;
    const strictAllowlist = readAllowlist(allowlist);
    return {
      ...required,
      ...(pluginConfigPaths?.length ? { pluginConfigPaths: [...pluginConfigPaths] } : {}),
      ...(strictAllowlist ? { allowlist: strictAllowlist } : {}),
    };
  }

  const raw = env[DOOM_MCP_SESSION_ENV_VAR];
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;

  const { repoRoot, generatedConfigPath, pluginConfigPaths, allowlist, stagingDirectory } = parsed as Record<
    string,
    unknown
  >;
  const resolvedRoot = typeof repoRoot === 'string' && repoRoot ? repoRoot : fallback.repoRoot;
  const generatedConfig =
    typeof generatedConfigPath === 'string' && generatedConfigPath ? generatedConfigPath : undefined;
  const plugins = asStringArray(pluginConfigPaths);
  const resolvedAllowlist = readAllowlist(allowlist);
  const staging =
    typeof stagingDirectory === 'string' && stagingDirectory ? stagingDirectory : fallback.stagingDirectory;

  return {
    repoRoot: resolvedRoot,
    stagingDirectory: staging,
    ...(generatedConfig ? { generatedConfigPath: generatedConfig } : {}),
    ...(plugins ? { pluginConfigPaths: plugins } : {}),
    ...(resolvedAllowlist ? { allowlist: resolvedAllowlist } : {}),
  };
}

/** Serializes the configuration for the Pi child process doom-pi launches. */
export function sessionConfigEnvironment(config: McpSessionConfig): Record<string, string> {
  return doomMcpSessionEnvironment(config);
}
