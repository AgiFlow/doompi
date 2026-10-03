import type { ToolCallEventResult, ToolResultEventResult } from '@earendil-works/pi-coding-agent';

import type { HookContext, HookNativeEvent } from '../../types/hookModule';
import type { HookDecision, HookFailure, HookPayload } from '../../types/hooks';

/** Host-owned identity and effects. No process-global child detection happens in dispatch. */
export interface HookDispatchScope extends HookContext {
  readonly operationSignal?: AbortSignal;
}

export interface HookDispatchRequest {
  readonly eventName: string;
  readonly event?: HookNativeEvent;
  readonly extraPayload?: HookPayload;
  readonly progress?: (index: number, total: number) => void;
}

export interface HookDispatchResult {
  readonly decisions: HookDecision[];
  readonly failures: HookFailure[];
  readonly toolCall?: Pick<ToolCallEventResult, 'block' | 'reason'>;
  readonly toolResult?: Pick<ToolResultEventResult, 'content' | 'details' | 'isError'>;
}
