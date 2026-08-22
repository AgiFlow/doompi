import type { ActiveGoal, GoalStateData, PendingQueueAction } from './goal.ts';
export interface GoalClock {
  now(): number;
}
export interface GoalIdFactory {
  create(): string;
}
export interface GoalStateStore {
  append(state: GoalStateData): void;
}
export interface GoalQueuePort {
  readonly enabled: boolean;
  readonly goals: readonly ActiveGoal[];
  readonly pendingAction?: PendingQueueAction;
}
