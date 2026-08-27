import { MAX_OBJECTIVE_LENGTH } from '../types/goal.ts';
import type { ActiveGoal, GoalStateData, LoadedGoalState, SafetyPauseCause } from '../types/goal.ts';
import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber, normalizeTokenBudget } from './accounting.ts';

export const GOAL_STATE_ENTRY_TYPE = 'goal-state';
export const LEGACY_GOAL_STATE_ENTRY_TYPE = 'goals-state';
/** The status the removed goal queue used; only ever read, never written. */
const RETIRED_QUEUED_STATUS = 'queued';
export interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}
export function serializeGoalState(goal: ActiveGoal | undefined): GoalStateData {
  return { goal: goal ?? null };
}
export function decodeGoalStateEntries(entries: readonly SessionEntryLike[]): LoadedGoalState {
  const canonical = [...entries]
    .reverse()
    .find((entry) => entry.type === 'custom' && entry.customType === GOAL_STATE_ENTRY_TYPE);
  if (canonical) return decodeCanonical(canonical.data);
  const legacy = [...entries]
    .reverse()
    .find((entry) => entry.type === 'custom' && entry.customType === LEGACY_GOAL_STATE_ENTRY_TYPE);
  return legacy ? decodeLegacy(legacy.data) : empty('none');
}
export function loadGoalStateFromSession(context: {
  sessionManager?: { getBranch?: () => SessionEntryLike[]; getEntries?: () => SessionEntryLike[] };
}): LoadedGoalState {
  return decodeGoalStateEntries(context.sessionManager?.getBranch?.() ?? context.sessionManager?.getEntries?.() ?? []);
}
export function normalizeLoadedGoal(goal: ActiveGoal, now = Date.now()): ActiveGoal {
  const status = normalizePersistedStatus(goal.status);
  return {
    ...goal,
    status,
    startedAt: timestamp(goal.startedAt) ? goal.startedAt : now,
    updatedAt: timestamp(goal.updatedAt) ? goal.updatedAt : now,
    iteration: counter(goal.iteration),
    tokenBudget: normalizeTokenBudget(goal.tokenBudget),
    tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
    timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
    baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
    activeStartedAt: status === 'active' ? (timestamp(goal.activeStartedAt) ? goal.activeStartedAt : now) : undefined,
    automaticModelTurns: counter(goal.automaticModelTurns),
    toolFreeRepeatCount: counter(goal.toolFreeRepeatCount),
    lastToolFreeOutputFingerprint: fingerprint(goal.lastToolFreeOutputFingerprint),
    safetyPauseCause: cause(goal.safetyPauseCause),
    safetyResetPending: goal.safetyResetPending === true ? true : undefined,
  };
}
export function isCanonicalGoalState(value: unknown): value is GoalStateData {
  return !decodeCanonical(value).malformed;
}
/**
 * A canonical entry, which may predate the removal of the goal queue and still
 * carry `queue` and `pendingAction`. Those keys are read past rather than
 * rejected: a session upgrading mid-flight keeps the objective it is working,
 * and the queue it can no longer act on simply stops being persisted on the
 * next commit.
 */
function decodeCanonical(value: unknown): LoadedGoalState {
  if (!record(value) || !Object.hasOwn(value, 'goal')) return empty('canonical', true);
  const rawGoal = value.goal;
  if (rawGoal !== null && !isGoal(rawGoal)) return empty('canonical', true);
  if (rawGoal === null) return empty('canonical');
  const goal = normalizeLoadedGoal(rawGoal);
  if (goal.status === 'complete') return empty('canonical');
  return { goal, source: 'canonical', malformed: false };
}
function decodeLegacy(value: unknown): LoadedGoalState {
  if (!record(value)) return empty('legacy-goals', true);
  const rawGoals = Array.isArray(value.goals) ? value.goals : isGoal(value.goal) ? [value.goal] : [];
  if (!rawGoals.every(isGoal)) return empty('legacy-goals', true);
  // Only the first survives: the rest were the queue.
  const goal = rawGoals.find((candidate) => candidate.status !== 'complete');
  if (!goal) return empty('legacy-goals');
  return { goal: normalizeLoadedGoal(goal), source: 'legacy-goals', malformed: false };
}
function isGoal(value: unknown): value is ActiveGoal {
  if (!record(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.trim() === value.id &&
    validObjective(value.text) &&
    status(value.status) &&
    timestamp(value.startedAt) &&
    timestamp(value.updatedAt) &&
    typeof value.iteration === 'number' &&
    Number.isFinite(value.iteration) &&
    isNonNegativeFiniteNumber(value.tokensUsed) &&
    isNonNegativeFiniteNumber(value.timeUsedSeconds) &&
    isNonNegativeFiniteNumber(value.baselineTokens) &&
    (value.tokenBudget === undefined || normalizeTokenBudget(value.tokenBudget) !== undefined) &&
    (value.activeStartedAt === undefined || timestamp(value.activeStartedAt))
  );
}
/**
 * A goal the removed queue had parked reads back as paused: it is retained,
 * carries no active clock, and needs an explicit resume, which is what being
 * queued behind another goal amounted to.
 */
function normalizePersistedStatus(value: ActiveGoal['status']): ActiveGoal['status'] {
  return (value as string) === RETIRED_QUEUED_STATUS ? 'paused' : value;
}
function validObjective(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_OBJECTIVE_LENGTH;
}
/**
 * A status a session may have written. 'queued' is still accepted because it
 * exists in state persisted before the queue was removed, and rejecting it
 * would fail the whole entry closed and lose the objective;
 * normalizePersistedStatus folds it onto the status it behaves as now.
 */
function status(value: unknown): value is ActiveGoal['status'] {
  return (
    value === 'active' ||
    value === RETIRED_QUEUED_STATUS ||
    value === 'paused' ||
    value === 'blocked' ||
    value === 'usage_limited' ||
    value === 'budget_limited' ||
    value === 'complete'
  );
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function counter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function fingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}
function cause(value: unknown): SafetyPauseCause | undefined {
  return value === 'continuation_limit' || value === 'no_progress' ? value : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function empty(source: LoadedGoalState['source'], malformed = false): LoadedGoalState {
  return { goal: undefined, source, malformed };
}
