import type { GoalStateData } from './goal.ts';
export interface GoalClock {
  now(): number;
}
export interface GoalIdFactory {
  create(): string;
}
export interface GoalStateStore {
  append(state: GoalStateData): void;
}
