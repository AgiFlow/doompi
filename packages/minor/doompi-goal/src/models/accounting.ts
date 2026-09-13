export interface GoalAccountingState {
  status: string;
  baselineTokens: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: number;
  activeStartedAt?: number;
}

export interface UsageLike {
  totalTokens?: unknown;
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

export interface UsageContext {
  sessionManager?: { getBranch?: () => unknown[] };
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function nonNegativeFiniteNumber(value: unknown): number {
  return isNonNegativeFiniteNumber(value) ? value : 0;
}

export function normalizeTokenBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function assistantUsageTokens(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const usage = value as UsageLike;
  if (isNonNegativeFiniteNumber(usage.totalTokens)) return usage.totalTokens;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    nonNegativeFiniteNumber(usage.input) +
      nonNegativeFiniteNumber(usage.output) +
      nonNegativeFiniteNumber(usage.cacheRead) +
      nonNegativeFiniteNumber(usage.cacheWrite),
  );
}

export function cumulativeAssistantTokens(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { type?: unknown; message?: unknown };
    if (candidate.type !== 'message' || !candidate.message || typeof candidate.message !== 'object') continue;
    const message = candidate.message as { role?: unknown; usage?: unknown };
    if (message.role === 'assistant')
      total = Math.min(Number.MAX_SAFE_INTEGER, total + assistantUsageTokens(message.usage));
  }
  return total;
}

export function currentTokenTotal(context: UsageContext): number {
  return cumulativeAssistantTokens(context.sessionManager?.getBranch?.() ?? []);
}

export function checkpointGoalActiveTime(goal: GoalAccountingState, now: number, continueClock: boolean): void {
  const startedAt = goal.activeStartedAt;
  goal.timeUsedSeconds =
    nonNegativeFiniteNumber(goal.timeUsedSeconds) +
    (typeof startedAt === 'number' && Number.isFinite(startedAt) ? Math.max(0, now - startedAt) / 1000 : 0);
  goal.activeStartedAt = continueClock ? now : undefined;
}

export function updateGoalUsage(
  goal: GoalAccountingState,
  context: UsageContext,
  now = Date.now(),
  continueClock = goal.status === 'active',
): void {
  goal.baselineTokens = nonNegativeFiniteNumber(goal.baselineTokens);
  goal.tokensUsed = Math.max(0, currentTokenTotal(context) - goal.baselineTokens);
  checkpointGoalActiveTime(goal, now, continueClock);
  goal.updatedAt = now;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(nonNegativeFiniteNumber(seconds)));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number): string {
  const normalized = Math.max(0, Math.floor(nonNegativeFiniteNumber(value)));
  if (normalized < 1000) return `${normalized}`;
  if (normalized < 1000000)
    return Number.isInteger(normalized / 1000) ? `${normalized / 1000}k` : `${(normalized / 1000).toFixed(1)}k`;
  return Number.isInteger(normalized / 1000000) ? `${normalized / 1000000}m` : `${(normalized / 1000000).toFixed(1)}m`;
}
