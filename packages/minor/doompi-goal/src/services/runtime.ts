import type { ActiveGoal, GoalRuntimeSnapshot, GoalStateData, PendingQueueAction } from '../types/goal.ts';
import { serializeGoalState } from './stateCodec.ts';
import { getExecutionState, transitionGoal } from './stateMachine.ts';
export interface RuntimeCommitPort {
  persist(state: GoalStateData): void;
}
export class GoalRuntimeModel {
  private current?: ActiveGoal;
  private queue: ActiveGoal[] = [];
  private pendingAction?: PendingQueueAction;
  private readonly loaded: boolean;
  constructor(port: RuntimeCommitPort, loaded = true) {
    this.port = port;
    this.loaded = loaded;
  }
  private readonly port: RuntimeCommitPort;
  snapshot(): GoalRuntimeSnapshot {
    return {
      loaded: this.loaded,
      execution: getExecutionState({ goal: this.current, queue: this.queue }),
      goal: this.current,
      queue: [...this.queue],
      pendingAction: this.pendingAction,
    };
  }
  load(state: { goal?: ActiveGoal; queue?: readonly ActiveGoal[]; pendingAction?: PendingQueueAction }): void {
    this.current = state.goal;
    this.queue = [...(state.queue ?? [])];
    this.pendingAction = state.pendingAction;
  }
  start(goal: ActiveGoal): GoalRuntimeSnapshot {
    this.commit({ goal, queue: this.queue, pendingAction: this.pendingAction });
    return this.snapshot();
  }
  stop(status: 'paused' | 'blocked' | 'usage_limited' | 'budget_limited'): GoalRuntimeSnapshot {
    if (!this.current) return this.snapshot();
    this.commit({ goal: transitionGoal(this.current, status), queue: this.queue, pendingAction: this.pendingAction });
    return this.snapshot();
  }
  clear(): GoalRuntimeSnapshot {
    this.commit({ goal: undefined, queue: [], pendingAction: undefined });
    return this.snapshot();
  }
  replaceState(state: {
    goal?: ActiveGoal;
    queue?: readonly ActiveGoal[];
    pendingAction?: PendingQueueAction;
  }): GoalRuntimeSnapshot {
    this.commit({ goal: state.goal, queue: state.queue ?? [], pendingAction: state.pendingAction });
    return this.snapshot();
  }
  private commit(state: { goal?: ActiveGoal; queue: readonly ActiveGoal[]; pendingAction?: PendingQueueAction }): void {
    this.port.persist(serializeGoalState(state.goal, state.queue, state.pendingAction));
    this.current = state.goal;
    this.queue = [...state.queue];
    this.pendingAction = state.pendingAction;
  }
}
