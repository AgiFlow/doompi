import type { CompatibilityProvider } from '../../types/interfaces/compatibility';
import type { CompatibilityContext } from '../compatibilityContext.ts';
import { launchAntigravity } from './antigravity.ts';
import { CODEX_PROVIDER, launchCodex } from './codex.ts';
import { runInteractive } from './process.ts';
import { additionalDirectoryArgs, SKIP_PERMISSIONS_OPTION } from './shared.ts';

export { adaptAntigravityMcpDefinition, antigravityCompatibilityArgs, launchAntigravity } from './antigravity.ts';
export {
  codexCompatibilityArgs,
  codexEnvironment,
  codexPluginDirectories,
  launchCodex,
  supportsCodexManagedProfile,
} from './codex.ts';
export {
  acquireDirectoryLock,
  forwardSignals,
  isFileSystemError,
  lockOwnerIsRunning,
  pathInside,
  runCaptured,
  runChecked,
  runInteractive,
  signalExitCode,
  waitForExit,
} from './process.ts';
export { mcpProxyArguments } from './shared.ts';

const CLAUDE_PROVIDER = 'claude';
/** The DoomPi-side flag that asks for the bypass, quoted back in the warning. */
const SKIP_PERMISSIONS_REQUEST_OPTION = '--skip-permissions';
const PLUGIN_DIRECTORY_OPTION = '--plugin-dir';
const MCP_CONFIG_OPTION = '--mcp-config';
const STRICT_MCP_CONFIG_OPTION = '--strict-mcp-config';
const APPEND_SYSTEM_PROMPT_FILE_OPTION = '--append-system-prompt-file';

/**
 * Claude needs no state sync: everything it reads is passed as an argument, so
 * a run leaves nothing behind to revert.
 */
export function claudeCompatibilityArgs(context: CompatibilityContext): string[] {
  const args = context.options.skipPermissions ? [SKIP_PERMISSIONS_OPTION] : [];
  for (const plugin of context.plugins) args.push(PLUGIN_DIRECTORY_OPTION, plugin.directory);
  if (context.mcpAllowlist) args.push(MCP_CONFIG_OPTION, context.mcpConfigPath, STRICT_MCP_CONFIG_OPTION);
  if (context.personaFile) args.push(APPEND_SYSTEM_PROMPT_FILE_OPTION, context.personaFile);
  args.push(...additionalDirectoryArgs(context));
  return [...args, ...context.options.providerArgs];
}

/**
 * One line on stderr, once per run, naming the frontend whose gate is off.
 *
 * The bypass is invisible in the child's own UI: the frontend simply stops
 * asking. Announcing it here is the only point where the user learns that the
 * absence of prompts was DoomPi's doing and not the frontend's default.
 */
function warnPermissionsBypassed(provider: CompatibilityProvider): void {
  process.stderr.write(
    `[doompi] ${SKIP_PERMISSIONS_REQUEST_OPTION}: approval prompts are disabled for this ${provider} run.\n`,
  );
}

export async function launchCompatibility(context: CompatibilityContext): Promise<number> {
  const provider: CompatibilityProvider = context.options.provider;
  if (context.options.skipPermissions) warnPermissionsBypassed(provider);
  if (provider === CLAUDE_PROVIDER) {
    return runInteractive(
      CLAUDE_PROVIDER,
      claudeCompatibilityArgs(context),
      context.options.currentDirectory,
      context.environment,
    );
  }
  if (provider === CODEX_PROVIDER) return launchCodex(context);
  return launchAntigravity(context);
}
