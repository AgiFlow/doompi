import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';
import { InlineAgentSchema } from './subagentTool.ts';

/** Team-owned Cordis service for one session's delegated runs. */
export const DOOM_DELEGATION_SERVICE = 'doom/delegation';
export const DOOM_DELEGATION_REQUESTED_EVENT = 'doom/delegation/requested';
export const DOOM_DELEGATION_ACCEPTED_EVENT = 'doom/delegation/accepted';
export const DOOM_DELEGATION_STARTED_EVENT = 'doom/delegation/started';
export const DOOM_DELEGATION_UPDATED_EVENT = 'doom/delegation/updated';
export const DOOM_DELEGATION_FINISHED_EVENT = 'doom/delegation/finished';
export const DOOM_DELEGATION_CANCELLED_EVENT = 'doom/delegation/cancelled';

export const DelegationRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    taskId: Type.Union([Type.String(), Type.Number()]),
    agent: Type.String({ minLength: 1 }),
    inlineAgent: Type.Optional(InlineAgentSchema),
    prompt: Type.String({ minLength: 1 }),
    cwd: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    context: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('fork')])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    artifacts: Type.Optional(Type.Boolean()),
    runMode: Type.Optional(Type.Union([Type.Literal('foreground'), Type.Literal('detached')])),
    teamTask: Type.Optional(
      Type.Object(
        { id: Type.String({ minLength: 1 }), subject: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type DelegationRequest = Static<typeof DelegationRequestSchema>;

export const DelegationAcceptedSchema = Type.Object(
  { requestId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type DelegationAccepted = Static<typeof DelegationAcceptedSchema>;

export const DelegationStartedSchema = Type.Object(
  { requestId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type DelegationStarted = Static<typeof DelegationStartedSchema>;

export const DelegationUpdateSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    status: Type.Optional(Type.String({ minLength: 1 })),
    currentTool: Type.Optional(Type.String({ minLength: 1 })),
    toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type DelegationUpdate = Static<typeof DelegationUpdateSchema>;

export const DelegationStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('timed_out'),
  Type.Literal('cancelled'),
  Type.Literal('interrupted'),
  Type.Literal('turn_budget_exhausted'),
  Type.Literal('tool_budget_exhausted'),
  Type.Literal('acceptance_failed'),
  Type.Literal('invalid_request'),
  Type.Literal('unavailable_context'),
]);
export type DelegationStatus = Static<typeof DelegationStatusSchema>;

export const DelegationResultSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    status: DelegationStatusSchema,
    output: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    outputPath: Type.Optional(Type.String({ minLength: 1 })),
    sessionFile: Type.Optional(Type.String({ minLength: 1 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type DelegationResult = Static<typeof DelegationResultSchema>;

export const DelegationCancelSchema = Type.Object(
  { requestId: Type.String({ minLength: 1 }), reason: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);
export type DelegationCancel = Static<typeof DelegationCancelSchema>;

export interface DoomDelegationService {
  readonly sessionId: string;
  readonly generation: string;
  request(request: DelegationRequest): Promise<void>;
  cancel(request: DelegationCancel): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/delegation': DoomDelegationService;
  }

  interface Events {
    'doom/delegation/requested'(event: DelegationRequest): void;
    'doom/delegation/accepted'(event: DelegationAccepted): void;
    'doom/delegation/started'(event: DelegationStarted): void;
    'doom/delegation/updated'(event: DelegationUpdate): void;
    'doom/delegation/finished'(event: DelegationResult): void;
    'doom/delegation/cancelled'(event: DelegationCancel): void;
  }
}

export function readDoomDelegationService(ctx: Context): DoomDelegationService | undefined {
  return ctx.get(DOOM_DELEGATION_SERVICE) as DoomDelegationService | undefined;
}
