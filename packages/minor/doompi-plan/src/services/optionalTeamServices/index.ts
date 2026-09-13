import type { Context } from '@deepseek-ai/cordis';

import { FABLE_PLAN_REQUESTER, type FablePlanRequest, type FablePlanResult } from '../fableFlow';

export const DOOM_FABLE_PLAN_SERVICE = 'doom/fable-plan';
export const DOOM_SUBAGENT_POLICY_SERVICE = 'doom/subagent-policy';

export interface DoomFablePlanService {
  start(request: FablePlanRequest, signal: AbortSignal): Promise<FablePlanResult>;
  cancel(request: { requester: typeof FABLE_PLAN_REQUESTER; operationId: string; reason: string }): void;
}

export interface SubagentPolicy {
  owner: string;
  allowedTools?: string[];
  requiredTools?: string[];
  allowMcpTools?: boolean;
  allowedExternalProfiles?: string[];
  denyExtensions?: boolean;
}

export interface SubagentPolicyHandle {
  update(policy: SubagentPolicy): void;
  dispose(): void;
}

export interface DoomSubagentPolicyService {
  register(policy: SubagentPolicy): SubagentPolicyHandle;
}

type StructuralServiceContext = {
  get(name: string): unknown;
};

export function readDoomFablePlanService(ctx: Context): DoomFablePlanService | undefined {
  return (ctx as unknown as StructuralServiceContext).get(DOOM_FABLE_PLAN_SERVICE) as DoomFablePlanService | undefined;
}

export function readDoomSubagentPolicyService(ctx: Context): DoomSubagentPolicyService | undefined {
  return (ctx as unknown as StructuralServiceContext).get(DOOM_SUBAGENT_POLICY_SERVICE) as
    | DoomSubagentPolicyService
    | undefined;
}
