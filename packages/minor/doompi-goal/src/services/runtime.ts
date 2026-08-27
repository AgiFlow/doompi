import type { ActiveGoal, GoalRuntimeSnapshot, GoalStateData } from '../types/goal.ts';
import { serializeGoalState } from './stateCodec.ts';
import { getExecutionState, transitionGoal } from './stateMachine.ts';
export interface RuntimeCommitPort {
  persist(state: GoalStateData): void;
}
export class GoalRuntimeModel {
  private current?: ActiveGoal;
  private readonly loaded: boolean;
  constructor(port: RuntimeCommitPort, loaded = true) {
    this.port = port;
    this.loaded = loaded;
  }
  private readonly port: RuntimeCommitPort;
  snapshot(): GoalRuntimeSnapshot {
    return {
      loaded: this.loaded,
      execution: getExecutionState({ goal: this.current }),
      goal: this.current,
    };
  }
  load(goal: ActiveGoal | undefined): void {
    this.current = goal;
  }
  start(goal: ActiveGoal): GoalRuntimeSnapshot {
    this.commit(goal);
    return this.snapshot();
  }
  stop(status: 'paused' | 'blocked' | 'usage_limited' | 'budget_limited'): GoalRuntimeSnapshot {
    if (!this.current) return this.snapshot();
    this.commit(transitionGoal(this.current, status));
    return this.snapshot();
  }
  clear(): GoalRuntimeSnapshot {
    this.commit(undefined);
    return this.snapshot();
  }
  replaceState(goal: ActiveGoal | undefined): GoalRuntimeSnapshot {
    this.commit(goal);
    return this.snapshot();
  }
  private commit(goal: ActiveGoal | undefined): void {
    this.port.persist(serializeGoalState(goal));
    this.current = goal;
  }
}
