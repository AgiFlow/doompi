import type { HookDecision, HookFailure, HookOutcome } from '../types/hooks.ts';

const BLOCK_DECISION = 'block';
const DENY_PERMISSION = 'deny';

export function decisionsFrom(outcomes: ReadonlyArray<HookOutcome>): HookDecision[] {
  return outcomes.flatMap((outcome) => (outcome.decision ? [outcome.decision] : []));
}

export function failuresFrom(outcomes: ReadonlyArray<HookOutcome>): HookFailure[] {
  return outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
}

/** Both spellings a hook may use to refuse the call it observed. */
export function isDenied(decision: HookDecision | undefined): boolean {
  return decision?.decision === BLOCK_DECISION || decision?.hookSpecificOutput?.permissionDecision === DENY_PERMISSION;
}

export function decisionReason(decision: HookDecision | undefined): string | undefined {
  return decision?.reason ?? decision?.hookSpecificOutput?.reason;
}

/** Context a hook wants added to the conversation rather than used to block. */
export function additionalContextsFrom(decisions: ReadonlyArray<HookDecision>): string[] {
  return decisions
    .map((decision) => decision.hookSpecificOutput?.additionalContext)
    .filter((value): value is string => Boolean(value));
}

/** What a post-tool hook has to say, whichever field it said it in. */
export function toolResultMessages(decisions: ReadonlyArray<HookDecision>): string[] {
  return decisions
    .map((decision) => decision.hookSpecificOutput?.additionalContext ?? decisionReason(decision))
    .filter((value): value is string => Boolean(value));
}

/**
 * A guardrail that never ran looks exactly like one that passed, so the agent is
 * told which checks were missed and what its options are.
 */
export function hookFailureMessage(failures: ReadonlyArray<HookFailure>): string {
  return [
    'One or more repository hooks did not complete, so their checks were not applied:',
    ...failures.map((failure) => `- ${failure.command}: ${failure.message}`),
    'Options:',
    '- Inspect the hook command or configuration and rerun after correcting it.',
    '- Continue only if the missed advisory check is acceptable.',
    '- Ask the user before bypassing a hook that may enforce a guardrail.',
  ].join('\n');
}
