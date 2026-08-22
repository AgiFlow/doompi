import type { ActiveGoal, SafetyPauseCause } from '../types/goal.ts';
export interface SafetySettings {
  automaticTurns: number | null;
  noProgressTurns: number | null;
}
export interface SafetyProgress {
  toolFreeRepeatCount: number;
  lastToolFreeOutputFingerprint?: string;
}
export function resetGoalSafetyEpoch(goal: ActiveGoal, now = Date.now()): ActiveGoal {
  return {
    ...goal,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
    safetyResetPending: undefined,
    updatedAt: now,
  };
}
export function nextToolFreeRepeatState(
  goal: Pick<ActiveGoal, 'toolFreeRepeatCount' | 'lastToolFreeOutputFingerprint'>,
  messages: readonly unknown[],
  toolAttempted: boolean,
): SafetyProgress {
  if (toolAttempted) return { toolFreeRepeatCount: 0, lastToolFreeOutputFingerprint: undefined };
  const fingerprint = outputFingerprint(messages);
  if (!fingerprint) return { toolFreeRepeatCount: 0, lastToolFreeOutputFingerprint: undefined };
  return {
    toolFreeRepeatCount: fingerprint === goal.lastToolFreeOutputFingerprint ? goal.toolFreeRepeatCount + 1 : 1,
    lastToolFreeOutputFingerprint: fingerprint,
  };
}
export function safetyLimitReached(
  goal: Pick<ActiveGoal, 'automaticModelTurns' | 'toolFreeRepeatCount'>,
  settings: SafetySettings,
): SafetyPauseCause | undefined {
  if (settings.automaticTurns !== null && goal.automaticModelTurns >= settings.automaticTurns)
    return 'continuation_limit';
  if (settings.noProgressTurns !== null && goal.toolFreeRepeatCount >= settings.noProgressTurns) return 'no_progress';
  return undefined;
}
export function shouldPauseForSafety(
  goal: Pick<ActiveGoal, 'status' | 'automaticModelTurns' | 'toolFreeRepeatCount'>,
  settings: SafetySettings,
): boolean {
  return goal.status === 'active' && safetyLimitReached(goal, settings) !== undefined;
}
export function outputFingerprint(messages: readonly unknown[]): string | undefined {
  const text = messages.map(messageText).filter(Boolean).join('\n');
  if (!text) return undefined;
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}`.repeat(8);
}
function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as { role?: unknown; content?: unknown; text?: unknown };
  if (candidate.role !== undefined && candidate.role !== 'assistant') return '';
  if (typeof candidate.text === 'string') return candidate.text;
  if (typeof candidate.content === 'string') return candidate.content;
  if (!Array.isArray(candidate.content)) return '';
  return candidate.content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('');
}
