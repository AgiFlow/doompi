import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';

/** Team-owned Cordis service for session-scoped subagent policy contributions. */
export const DOOM_SUBAGENT_POLICY_SERVICE = 'doom/subagent-policy';

export const SubagentPolicySchema = Type.Object(
  {
    owner: Type.String({ minLength: 1 }),
    allowedTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    requiredTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    allowMcpTools: Type.Optional(Type.Boolean()),
    allowedExternalProfiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }))),
    denyExtensions: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SubagentPolicy = Static<typeof SubagentPolicySchema>;

export interface SubagentPolicyHandle {
  readonly owner: string;
  readonly generation: string;
  update(policy: SubagentPolicy): void;
  dispose(): void;
}

export interface DoomSubagentPolicyService {
  readonly generation: string;
  register(policy: SubagentPolicy): SubagentPolicyHandle;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/subagent-policy': DoomSubagentPolicyService;
  }
}

export function readDoomSubagentPolicyService(ctx: Context): DoomSubagentPolicyService | undefined {
  return ctx.get(DOOM_SUBAGENT_POLICY_SERVICE) as DoomSubagentPolicyService | undefined;
}
