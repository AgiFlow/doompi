import type { HookContext, HookModuleResult, HookNativeEvent } from '../../types/hookModule';
import type { HookFailure, ResolvedHook } from '../../types/hooks';

export interface HookModulesOptions {
  descriptor?: { file: string };
}
export interface HookModuleOutcome {
  result?: HookModuleResult;
  failure?: HookFailure;
}
export interface HookModules {
  validate(
    rows: readonly (Pick<ResolvedHook, 'registryId' | 'groupId' | 'rowId' | 'event'> & { module?: string })[],
  ): Promise<void>;
  invoke(
    row: ResolvedHook,
    event: HookNativeEvent,
    context: HookContext,
    operationSignal?: AbortSignal,
  ): Promise<HookModuleOutcome>;
  dispose(): Promise<void>;
}
