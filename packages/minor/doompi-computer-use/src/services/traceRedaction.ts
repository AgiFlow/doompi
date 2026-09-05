import type { ComputerUseAction, ComputerUseFailureCode } from '../types/computerUse.ts';

export interface ComputerUseTraceInput {
  readonly sequence: number;
  readonly timestamp: number;
  readonly runId: string;
  readonly bundleId: string;
  readonly action: ComputerUseAction;
  readonly role?: string;
  readonly durationMs: number;
  readonly outcome: 'succeeded' | 'failed' | 'uncertain';
  readonly errorCode?: ComputerUseFailureCode;
}

export interface ComputerUseTraceRecord {
  readonly sequence: number;
  readonly timestamp: number;
  readonly runId: string;
  readonly bundleId: string;
  readonly actionKind: ComputerUseAction['kind'];
  readonly role?: string;
  readonly textLength?: number;
  readonly durationMs: number;
  readonly outcome: ComputerUseTraceInput['outcome'];
  readonly errorCode?: ComputerUseFailureCode;
}

export function redactComputerUseTrace(input: ComputerUseTraceInput): ComputerUseTraceRecord {
  return {
    sequence: input.sequence,
    timestamp: input.timestamp,
    runId: input.runId,
    bundleId: input.bundleId,
    actionKind: input.action.kind,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.action.kind === 'set_value' ? { textLength: input.action.value.length } : {}),
    durationMs: input.durationMs,
    outcome: input.outcome,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
}
