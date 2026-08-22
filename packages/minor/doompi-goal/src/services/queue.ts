import type { ActiveGoal, PendingQueueAction } from '../types/goal.ts';
import { createGoal, nextGoalInstance, transitionGoal } from './stateMachine.ts';
export interface QueueState {
  goal?: ActiveGoal;
  queue: ActiveGoal[];
  pendingAction?: PendingQueueAction;
  enabled: boolean;
}
export function activateQueuedGoal(
  goal: ActiveGoal,
  now = Date.now(),
  baselineTokens = goal.baselineTokens,
): ActiveGoal {
  return nextGoalInstance({ ...goal, baselineTokens }, now);
}
export function enqueueGoal(state: QueueState, objective: string, tokenBudget?: number, now = Date.now()): QueueState {
  if (!state.enabled) return state;
  const queued = transitionGoal(createGoal(objective, tokenBudget, { now }), 'queued', now);
  return { ...state, queue: [...state.queue, queued] };
}
export function prioritizeGoal(state: QueueState, objective: string, tokenBudget?: number): QueueState {
  if (!state.enabled) return state;
  return { ...state, pendingAction: { kind: 'prioritize', objective, tokenBudget } };
}
export function dropLastGoal(state: QueueState): QueueState {
  if (!state.enabled || state.queue.length === 0) return state;
  return { ...state, queue: state.queue.slice(0, -1) };
}
export function skipCurrentGoal(state: QueueState): QueueState {
  if (!state.enabled || !state.goal) return state;
  const completed = transitionGoal(state.goal, 'complete');
  if (state.queue.length === 0) return { ...state, goal: completed, pendingAction: undefined };
  return {
    ...state,
    goal: completed,
    pendingAction: { kind: 'advance', goalId: state.goal.id, reason: 'skip', completedText: state.goal.text },
  };
}
export function promoteNextGoal(state: QueueState, now = Date.now(), baselineTokens?: number): QueueState {
  if (!state.enabled || !state.goal || state.queue.length === 0) return state;
  const [next, ...remaining] = state.queue;
  return {
    ...state,
    goal: activateQueuedGoal(next, now, baselineTokens),
    queue: remaining,
    pendingAction: undefined,
  };
}
export function restartGoalFromHistory(
  goal: Pick<ActiveGoal, 'text' | 'tokenBudget' | 'baselineTokens'>,
  now = Date.now(),
): ActiveGoal {
  return nextGoalInstance(createGoal(goal.text, goal.tokenBudget, { now, baselineTokens: goal.baselineTokens }), now);
}
export function clearQueue(state: QueueState): QueueState {
  return { ...state, queue: [], pendingAction: undefined };
}
