import type {
  ActiveGoal,
  GoalStateData,
  LoadedGoalState,
  PendingQueueAction,
  SafetyPauseCause,
} from '../types/goal.ts';
import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber, normalizeTokenBudget } from './accounting.ts';
import { MAX_OBJECTIVE_LENGTH } from './parser.ts';
export const GOAL_STATE_ENTRY_TYPE = 'goal-state';
export const LEGACY_GOAL_STATE_ENTRY_TYPE = 'goals-state';
export interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}
export function serializeGoalState(
  goal: ActiveGoal | undefined,
  queue: readonly ActiveGoal[] = [],
  pendingAction?: PendingQueueAction,
): GoalStateData {
  return {
    goal: goal ?? null,
    ...(queue.length ? { queue: queue.map((item) => ({ ...item })) } : {}),
    ...(pendingAction ? { pendingAction: { ...pendingAction } } : {}),
  };
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
  return {
    ...goal,
    startedAt: timestamp(goal.startedAt) ? goal.startedAt : now,
    updatedAt: timestamp(goal.updatedAt) ? goal.updatedAt : now,
    iteration: counter(goal.iteration),
    tokenBudget: normalizeTokenBudget(goal.tokenBudget),
    tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
    timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
    baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
    activeStartedAt:
      goal.status === 'active' ? (timestamp(goal.activeStartedAt) ? goal.activeStartedAt : now) : undefined,
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
function decodeCanonical(value: unknown): LoadedGoalState {
  if (!record(value) || !Object.hasOwn(value, 'goal')) return empty('canonical', true);
  const rawGoal = value.goal;
  if (rawGoal !== null && !isGoal(rawGoal)) return empty('canonical', true);
  const queueValue = value.queue;
  if (queueValue !== undefined && (!Array.isArray(queueValue) || !queueValue.every(isQueueGoal)))
    return empty('canonical', true);
  const pendingValue = value.pendingAction;
  const pending = pendingValue === undefined ? undefined : normalizePending(pendingValue);
  if (pendingValue !== undefined && !pending) return empty('canonical', true);
  if (rawGoal === null) return empty('canonical');
  const goal = normalizeLoadedGoal(rawGoal);
  if (goal.status === 'complete' && !pending) return empty('canonical');
  const queue = (queueValue ?? []).map(normalizeQueued);
  if (goal.status === 'queued' && !queue.length && !pending) return empty('canonical', true);
  return {
    goal,
    queue,
    pendingAction: pending,
    hasExperimentalQueueState: goal.status === 'queued' || queue.length > 0 || pending !== undefined,
    source: 'canonical',
    malformed: false,
  };
}
function decodeLegacy(value: unknown): LoadedGoalState {
  if (!record(value)) return empty('legacy-goals', true);
  const rawGoals = Array.isArray(value.goals) ? value.goals : isGoal(value.goal) ? [value.goal] : [];
  if (!rawGoals.every(isGoal)) return empty('legacy-goals', true);
  const pending = value.pendingUnshift === undefined ? undefined : normalizeLegacyPending(value.pendingUnshift);
  if (value.pendingUnshift !== undefined && !pending) return empty('legacy-goals', true);
  const goals = rawGoals.filter((goal) => goal.status !== 'complete');
  if (!goals.length) return empty('legacy-goals');
  const normalized = goals.map((goal, index) => (index === 0 ? normalizeLoadedGoal(goal) : normalizeQueued(goal)));
  return {
    goal: normalized[0],
    queue: normalized.slice(1),
    pendingAction: pending,
    hasExperimentalQueueState: normalized.length > 1 || normalized[0]?.status === 'queued' || pending !== undefined,
    source: 'legacy-goals',
    malformed: false,
  };
}
function normalizeQueued(goal: ActiveGoal): ActiveGoal {
  const normalized = normalizeLoadedGoal(goal);
  return {
    ...normalized,
    status: normalized.status === 'active' ? 'queued' : normalized.status,
    activeStartedAt: undefined,
  };
}
function normalizePending(value: unknown): PendingQueueAction | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'prioritize') {
    if (
      !validObjective(value.objective) ||
      (value.tokenBudget !== undefined && !normalizeTokenBudget(value.tokenBudget)) ||
      (value.displacedUsageFinalized !== undefined && typeof value.displacedUsageFinalized !== 'boolean')
    )
      return undefined;
    return {
      kind: 'prioritize',
      objective: value.objective,
      tokenBudget: normalizeTokenBudget(value.tokenBudget),
      ...(value.displacedUsageFinalized === true ? { displacedUsageFinalized: true } : {}),
    };
  }
  if (
    value.kind === 'advance' &&
    typeof value.goalId === 'string' &&
    value.goalId.trim() === value.goalId &&
    value.goalId &&
    (value.reason === 'complete' || value.reason === 'skip') &&
    validObjective(value.completedText)
  )
    return { kind: 'advance', goalId: value.goalId, reason: value.reason, completedText: value.completedText };
  return undefined;
}
function normalizeLegacyPending(value: unknown): PendingQueueAction | undefined {
  return record(value) && validObjective(value.objective)
    ? { kind: 'prioritize', objective: value.objective, tokenBudget: normalizeTokenBudget(value.tokenBudget) }
    : undefined;
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
function isQueueGoal(value: unknown): value is ActiveGoal {
  return isGoal(value) && value.status !== 'complete';
}
function validObjective(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_OBJECTIVE_LENGTH;
}
function status(value: unknown): value is ActiveGoal['status'] {
  return (
    value === 'active' ||
    value === 'queued' ||
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
  return { goal: undefined, queue: [], pendingAction: undefined, hasExperimentalQueueState: false, source, malformed };
}
