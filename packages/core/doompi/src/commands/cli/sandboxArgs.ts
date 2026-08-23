import type { HarnessOptions } from '../../types/interfaces/harness';
import { ADD_DIRECTORY_OPTION, DOMAINS_OPTION, MAJOR_MODE_OPTION, PROFILE_OPTION } from './matrixOptions.ts';

const NO_DOMAINS_OPTION = '--no-domains';
const PLUGIN_DIRECTORY_OPTION = '--plugin-dir';
const PRESET_OPTION = '--preset';
const CWD_OPTION = '--cwd';
const OUTPUT_FORMAT_OPTION = '--output-format';
const VIBE_LINT_FORMAT = 'vibe-lint';
const AUTOMATION_OPTION = '--automation';
const MUTE_OPTION = '--mute';
const AUTO_STOP_OPTION = '--auto-stop';
const ALLOW_PROTECTED_WRITES_OPTION = '--allow-protected-writes';
const NO_HOOKS_OPTION = '--no-hooks';
const NO_MCP_OPTION = '--no-mcp';
const NO_AGENTS_OPTION = '--no-agents';

/**
 * Projects resolved harness options back into replayable harness arguments.
 *
 * The sandbox provider hands these to the launcher inside the sandbox, which
 * re-parses them exactly like a host launch. The projection never contains
 * --sandbox: a sandboxed launch must not provision another sandbox.
 */
export function buildSandboxForwardArgs(options: HarnessOptions): string[] {
  const args: string[] = [MAJOR_MODE_OPTION, options.majorMode, PRESET_OPTION, options.preset, CWD_OPTION, options.cwd];
  if (options.profile) args.push(PROFILE_OPTION, options.profile);
  if (options.domains.length > 0) args.push(DOMAINS_OPTION, options.domains.join(','));
  // With no domains and no plugin directories, silence would re-trigger the
  // major mode's default domains inside the sandbox.
  else if (options.pluginDirectories.length === 0) args.push(NO_DOMAINS_OPTION);
  for (const directory of options.pluginDirectories) args.push(PLUGIN_DIRECTORY_OPTION, directory);
  for (const directory of options.additionalDirectories) args.push(ADD_DIRECTORY_OPTION, directory);
  if (options.outputFormat === VIBE_LINT_FORMAT) args.push(OUTPUT_FORMAT_OPTION, VIBE_LINT_FORMAT);
  if (options.automation) args.push(AUTOMATION_OPTION);
  if (options.mute) args.push(MUTE_OPTION);
  if (options.autoStop) args.push(AUTO_STOP_OPTION);
  if (options.allowProtectedWrites) args.push(ALLOW_PROTECTED_WRITES_OPTION);
  if (!options.hooks) args.push(NO_HOOKS_OPTION);
  if (!options.mcp) args.push(NO_MCP_OPTION);
  if (!options.agents) args.push(NO_AGENTS_OPTION);
  return [...args, ...options.piArgs];
}
