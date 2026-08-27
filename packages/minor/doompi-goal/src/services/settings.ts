import type { GoalToolVisibility } from '../types/settings.ts';
export interface GoalSettings {
  toolVisibility: GoalToolVisibility;
  continuationLimits: { automaticTurns: number | null; noProgressTurns: number | null };
}
export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
  toolVisibility: 'operational',
  continuationLimits: { automaticTurns: null, noProgressTurns: 3 },
};
export interface GoalSettingsLoadResult {
  kind: 'missing' | 'invalid' | 'loaded';
  settings?: GoalSettings;
  reason?: string;
}
export function normalizeGoalSettings(value: unknown): GoalSettings | undefined {
  if (!record(value)) return undefined;
  const toolVisibility = normalizeToolVisibility(value.toolVisibility);
  if (!toolVisibility) return undefined;
  // `experimental` opted into the removed goal queue. A file that still carries
  // it is read as if it did not, rather than refused.
  if (value.continuationLimits !== undefined && !record(value.continuationLimits)) return undefined;
  const limits = record(value.continuationLimits) ? value.continuationLimits : {};
  const automaticTurns = normalizeLimit(limits.automaticTurns, null);
  const noProgressTurns = normalizeLimit(limits.noProgressTurns, 3);
  if (automaticTurns === undefined || noProgressTurns === undefined) return undefined;
  return { toolVisibility, continuationLimits: { automaticTurns, noProgressTurns } };
}
export function normalizeToolVisibility(value: unknown): GoalToolVisibility | undefined {
  return value === undefined || value === 'always' || value === 'after-first-goal' || value === 'operational'
    ? 'operational'
    : undefined;
}
export function decodeGoalSettings(value: unknown): GoalSettingsLoadResult {
  const settings = normalizeGoalSettings(value);
  return settings ? { kind: 'loaded', settings } : { kind: 'invalid', reason: 'invalid Goal settings shape' };
}
function normalizeLimit(value: unknown, fallback: number | null): number | null | undefined {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
