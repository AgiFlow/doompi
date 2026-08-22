/**
 * Cross-process environment variable names.
 *
 * DESIGN PATTERNS:
 * - Zero imports, so any process role can read these without pulling in runtime
 * - Names AND values are identical to the predecessor package on purpose
 *
 * WHY THE VALUES ARE UNCHANGED:
 * `PI_SUBAGENT_CHILD` and `PI_SUBAGENT_PARENT_SESSION` are how sibling
 * extensions decide whether they are running inside a subagent child. A child
 * reads whatever its spawning parent set, so during cutover a consumer that has
 * already moved to this package can still be spawned by a doom-pi-subagents
 * parent. Re-prefixing the values would make that child fail to recognise
 * itself. Filesystem roots are namespaced instead; those are what actually
 * needed isolating.
 *
 * AVOID:
 * - Re-prefixing these values; the isolation belongs in the temp roots
 * - Hardcoding any of these literals at a call site
 */

export {
  SUBAGENT_CHILD_ENV,
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_ROOT_SESSION_ENV,
} from '@agimon-ai/doompi-extension-contracts/child-process';

export const SUBAGENT_RUN_ID_ENV = 'PI_SUBAGENT_RUN_ID';
export const SUBAGENT_CHILD_AGENT_ENV = 'PI_SUBAGENT_CHILD_AGENT';
export const SUBAGENT_CHILD_INDEX_ENV = 'PI_SUBAGENT_CHILD_INDEX';
export const SUBAGENT_FANOUT_CHILD_ENV = 'PI_SUBAGENT_FANOUT_CHILD';
export const SUBAGENT_PARENT_EVENT_SINK_ENV = 'PI_SUBAGENT_PARENT_EVENT_SINK';
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = 'PI_SUBAGENT_PARENT_CONTROL_INBOX';
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = 'PI_SUBAGENT_PARENT_ROOT_RUN_ID';
export const SUBAGENT_PARENT_RUN_ID_ENV = 'PI_SUBAGENT_PARENT_RUN_ID';
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = 'PI_SUBAGENT_PARENT_CHILD_INDEX';
export const SUBAGENT_PARENT_DEPTH_ENV = 'PI_SUBAGENT_PARENT_DEPTH';
export const SUBAGENT_PARENT_PATH_ENV = 'PI_SUBAGENT_PARENT_PATH';
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = 'PI_SUBAGENT_PARENT_CAPABILITY_TOKEN';
/** Parent/workflow process ids a child Bash tool must never signal. */
export const SUBAGENT_PROTECTED_PARENT_PIDS_ENV = 'PI_SUBAGENT_PROTECTED_PARENT_PIDS';

/** Decode the parent-owned PID allowlist without trusting malformed environment state. */
export function decodeProtectedParentProcessIds(encoded: string | undefined): number[] {
  if (!encoded) return [];
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 1,
        ),
      ),
    ];
  } catch {
    return [];
  }
}
export const SUBAGENT_STEER_INBOX_ENV = 'PI_SUBAGENT_STEER_INBOX';
export const SUBAGENT_STEER_CAPABILITY_ENV = 'PI_SUBAGENT_STEER_CAPABILITY';
export const SUBAGENT_STEER_ACK_DIR_ENV = 'PI_SUBAGENT_STEER_ACK_DIR';

/** The in-process SDK runtime. Not an external command; see `runtimeRegistry.ts`. */
export const PI_RUNTIME_NAME = 'pi';

/**
 * Per-runtime binary override, e.g. `DOOM_TEAM_CLAUDE_BIN=/path/to/claude`.
 *
 * Uppercased and non-alphanumerics folded to `_` so a runtime name that is
 * legal in config is always a legal environment variable name.
 */
export function runtimeBinaryEnvVar(runtime: string): string {
  return `DOOM_TEAM_${runtime.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BIN`;
}

export const SUBAGENT_TEAM_ID_ENV = 'PI_SUBAGENT_TEAM_ID';
export const SUBAGENT_TEAM_ROOT_SESSION_ENV = 'PI_SUBAGENT_TEAM_ROOT_SESSION';
export const SUBAGENT_TEAM_MAIN_MEMBER_ENV = 'PI_SUBAGENT_TEAM_MAIN_MEMBER';
export const SUBAGENT_TEAM_MEMBER_ID_ENV = 'PI_SUBAGENT_TEAM_MEMBER_ID';
export const SUBAGENT_TEAM_MEMBER_TOKEN_ENV = 'PI_SUBAGENT_TEAM_MEMBER_TOKEN';

export const SUBAGENT_CAPABILITY_CEILING_ENV = 'PI_SUBAGENT_CAPABILITY_CEILING_V1';
export const REQUIRED_CHILD_TOOLS_ENV = 'PI_SUBAGENT_REQUIRED_TOOLS';
export const MCP_DIRECT_CHILD_TOOLS_ENV = 'PI_SUBAGENT_MCP_DIRECT_TOOLS';
export const CHILD_TOOL_DIAGNOSTIC_PATH_ENV = 'PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH';
export const TOOL_BUDGET_ENV = 'PI_SUBAGENT_TOOL_BUDGET';
export const TOOL_BUDGET_ZERO_AUTH_ENV = 'PI_SUBAGENT_TOOL_BUDGET_ZERO_AUTH';
export const MAX_SPAWNS_PER_SESSION_ENV = 'PI_SUBAGENT_MAX_SPAWNS_PER_SESSION';
export const STRUCTURED_OUTPUT_SCHEMA_ENV = 'PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA';
export const STRUCTURED_OUTPUT_CAPTURE_ENV = 'PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE';
export const INHERIT_PROJECT_CONTEXT_ENV = 'PI_SUBAGENT_INHERIT_PROJECT_CONTEXT';
export const INHERIT_SKILLS_ENV = 'PI_SUBAGENT_INHERIT_SKILLS';
/**
 * Unprefixed on purpose: this one belongs to the Pi host, not to us. The child's
 * Pi runtime reads it directly, so the name is fixed by that contract and must
 * not be brought under the `PI_SUBAGENT_` namespace.
 */
export const MCP_DIRECT_TOOLS_ENV = 'MCP_DIRECT_TOOLS';
/** Overrides where worktrees are created, for hosts whose tmpdir is unsuitable. */
export const WORKTREE_BASE_DIR_ENV = 'PI_SUBAGENTS_WORKTREE_DIR';
export const EXTRA_AGENT_DIRS_ENV = 'PI_SUBAGENT_EXTRA_AGENT_DIRS';
export const EXTRA_SKILL_DIRS_ENV = 'PI_SUBAGENT_EXTRA_SKILL_DIRS';
export const PI_SUBAGENT_PI_BINARY_ENV = 'PI_SUBAGENT_PI_BINARY';
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT';
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = 'PI_SUBAGENT_INTERCOM_SESSION_NAME';
export const PI_INTERCOM_STABLE_ID_ENV = 'PI_INTERCOM_STABLE_ID';
export const PI_INTERCOM_SESSION_ID_ENV = 'PI_INTERCOM_SESSION_ID';

/** Resolved child-safe DoomPi extensions inherited by SDK-backed agents. */
export const DOOMPI_CHILD_EXTENSIONS_ENV = 'DOOMPI_CHILD_EXTENSIONS';
/** Resolved DoomPi domain skill directories inherited by SDK-backed agents. */
export const DOOMPI_SKILL_DIRS_ENV = 'DOOMPI_SKILL_DIRS';
