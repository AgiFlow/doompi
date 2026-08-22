/**
 * Maps a parsed slash-command step (`chainExpression.ts`'s `ParsedStep`/
 * carrying the predecessor's full 13-key inline-config
 * vocabulary) onto `SpawnPlanner`'s actual request shapes
 * (`SpawnPlanTaskInput`), which accepts far fewer
 * fields today.
 *
 * WHY A SET INLINE-CONFIG KEY WITH NO DESTINATION THROWS, RATHER THAN
 * BEING DROPPED:
 * Parsing syntax a user can type and then silently ignoring it is the same
 * class of lie as a coverage number that does not mean what it claims -
 * nothing would tell the user their `[skill=x]` did nothing, and they would
 * reasonably conclude the feature is broken rather than simply not built
 * yet. `port-result-watcher` explicitly deferred per-task
 * `skill`/`toolBudget`/`turnBudget`/`outputSchema`/`acceptance`/`output`
 * overrides when it built `spawnPlan.ts` - listed as unwired, not
 * unwanted - so this is scoping DOWN a vocabulary that already has a home
 * to grow back into, not designing a small one. The error names the exact
 * key and says "not yet supported", distinct from an unrecognized key
 * (which `parseInlineConfig` already drops silently, matching the
 * predecessor's own behavior for a typo).
 *
 * WHY THE NOT-YET-SUPPORTED LIST IS DATA, NOT A SWITCH:
 * Wiring one of these up later (e.g. once `SpawnPlanTaskInput` grows a
 * `skill` field) means deleting one entry from
 * `NOT_YET_SUPPORTED_INLINE_CONFIG_KEYS` and adding the field to the
 * builder functions below - not re-deriving which keys are safe to pass
 * through.
 *
 * AVOID:
 * - Silently dropping a set inline-config key with no destination
 * - Inlining the not-yet-supported check as ad hoc `if` statements at each
 *   call site instead of the shared list below
 */

import type { SpawnPlanTaskInput } from '../../extensions/spawnPlan';
import type { InlineConfig, ParsedStep } from './chainExpression';

interface NotYetSupportedKey {
  key: keyof InlineConfig;
  isSet: (config: InlineConfig) => boolean;
}

const NOT_YET_SUPPORTED_INLINE_CONFIG_KEYS: readonly NotYetSupportedKey[] = [
  { key: 'output', isSet: (c) => c.output !== undefined },
  { key: 'outputMode', isSet: (c) => c.outputMode !== undefined },
  { key: 'reads', isSet: (c) => c.reads !== undefined },
  { key: 'skill', isSet: (c) => c.skill !== undefined },
  { key: 'progress', isSet: (c) => c.progress !== undefined },
  { key: 'count', isSet: (c) => c.count !== undefined },
  { key: 'outputSchema', isSet: (c) => c.outputSchema !== undefined },
  { key: 'acceptance', isSet: (c) => c.acceptance !== undefined },
];

export class UnsupportedInlineConfigError extends Error {
  constructor(
    readonly key: string,
    agentName: string,
  ) {
    super(`'${key}' is not supported yet for '${agentName}': SpawnPlanner does not accept it as a per-task override.`);
    this.name = 'UnsupportedInlineConfigError';
  }
}

/** Throws `UnsupportedInlineConfigError` naming the first not-yet-supported key the user actually set. */
export function assertSupportedInlineConfig(config: InlineConfig, agentName: string): void {
  for (const { key, isSet } of NOT_YET_SUPPORTED_INLINE_CONFIG_KEYS) {
    if (isSet(config)) throw new UnsupportedInlineConfigError(key, agentName);
  }
}

/** Builds a `SpawnPlanTaskInput` for a SINGLE/PARALLEL step. Throws if the step set a not-yet-supported inline-config key. */
export function taskInputFromParsedStep(
  step: Pick<ParsedStep, 'name' | 'config' | 'task'>,
  cwd: string,
  context?: 'fresh' | 'fork',
): SpawnPlanTaskInput {
  assertSupportedInlineConfig(step.config, step.name);
  return {
    agent: step.name,
    ...(step.task ? { task: step.task } : {}),
    cwd: step.config.cwd ?? cwd,
    ...(step.config.model ? { model: step.config.model } : {}),
    ...(context ? { context } : {}),
  };
}
