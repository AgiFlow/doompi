/**
 * Enforces `maxSubagentDepth`: how many spawn-levels deep a chain of
 * subagents may go before a further spawn is refused.
 *
 * WHY ABSENT MEANS DEPTH 0, NOT "UNKNOWN, REFUSE":
 * `SUBAGENT_PARENT_DEPTH_ENV` is only ever set by a parent that is itself a
 * spawned child (see `piArgs.ts`'s child env contract). A root session -
 * the common case, and every top-level spawn - never has it set. Treating
 * absence as "unknown depth" and failing closed would refuse every
 * top-level spawn, which is the opposite of the intended behavior. Absence
 * means this process IS the root, depth 0.
 *
 * WHY A PRESENT-BUT-UNPARSEABLE VALUE IS A HARD FAILURE, NOT A SILENT 0:
 * Falling back to 0 for a corrupted value would make a runaway or tampered
 * depth chain invisible - exactly the failure mode this guard exists to
 * catch. A value that is present but not a valid non-negative integer is
 * treated as more suspicious than merely absent, not less.
 *
 * TWO SEPARATE STEPS, MATCHING `spawn-budget.ts`'S RESOLVE/PREFLIGHT SPLIT:
 * `resolveCurrentSubagentDepth` only reads and validates this process's own
 * depth (throws on corruption); `preflightSubagentDepth` only compares an
 * already-resolved depth against the configured limit, returning a
 * describable `{error}` the same shape `spawn-budget.ts` already uses for
 * "over the limit" - a business-rule refusal, not an anomaly, so it does
 * not throw on its own. The caller (`spawnPlan.ts`'s preflight) decides
 * when to turn a returned `error` into an actual throw.
 */

import { SUBAGENT_PARENT_DEPTH_ENV } from '../../../types/environment';

/** The slice of extension configuration this module reads. */
export interface DepthGuardLimitConfig {
  maxSubagentDepth?: number;
}

export interface DepthPreflightResult {
  depth: number;
  limit: number | undefined;
  error?: string;
}

/**
 * This process's own spawn depth: 0 for a root session, N for the Nth-level
 * child of a chain of spawns. Throws when `SUBAGENT_PARENT_DEPTH_ENV` is
 * present but not a valid non-negative integer - see the module header.
 */
export function resolveCurrentSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SUBAGENT_PARENT_DEPTH_ENV];
  if (raw === undefined) return 0;
  // An empty string is "present but says nothing", not "present and zero" -
  // `Number('')` is 0 by a JS quirk, which would otherwise let a blank env
  // var silently pass as a valid depth.
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${SUBAGENT_PARENT_DEPTH_ENV} is set to an invalid value (${JSON.stringify(raw)}); expected a non-negative integer.`,
    );
  }
  return parsed;
}

/**
 * Would a spawn from a process at `depth` exceed `config.maxSubagentDepth`?
 * A configured limit of 0 or `undefined` means no limit. At the limit is
 * allowed - the refusal is for a depth one PAST it, per the boundary team
 * lead specified: `depth === limit` passes, `depth === limit + 1` refuses.
 */
export function preflightSubagentDepth(depth: number, config: DepthGuardLimitConfig): DepthPreflightResult {
  const limit =
    typeof config.maxSubagentDepth === 'number' &&
    Number.isInteger(config.maxSubagentDepth) &&
    config.maxSubagentDepth > 0
      ? config.maxSubagentDepth
      : undefined;
  if (limit === undefined || depth <= limit) return { depth, limit };
  return {
    depth,
    limit,
    error: `Subagent spawn refused: this process is already at depth ${depth}, past the configured maxSubagentDepth of ${limit}.`,
  };
}
