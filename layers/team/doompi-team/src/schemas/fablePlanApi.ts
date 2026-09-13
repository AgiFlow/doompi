import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';

export const FABLE_PLAN_REQUESTER = '@agimon-ai/doompi-plan' as const;
export const FABLE_PLAN_RUNTIME = 'claude' as const;
export const FABLE_PLAN_MODEL = 'fable' as const;
export const FABLE_PLAN_PROFILE = 'claude/fable-plan-v1' as const;
export const DOOM_FABLE_PLAN_SERVICE = 'doom/fable-plan';

const MAX_OPERATION_ID_LENGTH = 128;
const MAX_RUN_ID_LENGTH = 128;
const MAX_SOURCE_PATH_LENGTH = 512;
const MAX_ITEM_LENGTH = 4_096;
const MAX_GOAL_ITEMS = 8;
const MAX_CONSTRAINT_ITEMS = 16;
const MAX_DECISION_ITEMS = 16;
const MAX_FINDING_ITEMS = 24;
const MAX_QUESTION_ITEMS = 16;
const MAX_PLAN_LENGTH = 16_384;
const MAX_OUTPUT_LENGTH = 16_384;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_STATUS_LENGTH = 128;

const OperationIdSchema = Type.String({ minLength: 1, maxLength: MAX_OPERATION_ID_LENGTH });
const RunIdSchema = Type.String({ minLength: 1, maxLength: MAX_RUN_ID_LENGTH });
const ItemSchema = Type.String({ minLength: 1, maxLength: MAX_ITEM_LENGTH });

export const FablePlanFindingSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_SOURCE_PATH_LENGTH }),
    finding: ItemSchema,
  },
  { additionalProperties: false },
);
export type FablePlanFinding = Static<typeof FablePlanFindingSchema>;

export const FablePlanPacketSchema = Type.Object(
  {
    goal: Type.Array(ItemSchema, { minItems: 1, maxItems: MAX_GOAL_ITEMS }),
    constraints: Type.Array(ItemSchema, { maxItems: MAX_CONSTRAINT_ITEMS }),
    decisions: Type.Array(ItemSchema, { maxItems: MAX_DECISION_ITEMS }),
    verifiedFindings: Type.Array(FablePlanFindingSchema, { maxItems: MAX_FINDING_ITEMS }),
    inferredFindings: Type.Array(ItemSchema, { maxItems: MAX_FINDING_ITEMS }),
    unresolvedQuestions: Type.Array(ItemSchema, { maxItems: MAX_QUESTION_ITEMS }),
    currentPlan: Type.Optional(Type.String({ maxLength: MAX_PLAN_LENGTH })),
  },
  { additionalProperties: false },
);
export type FablePlanPacket = Static<typeof FablePlanPacketSchema>;

export const FablePlanStageSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('review'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('interrupted'),
]);
export type FablePlanStage = Static<typeof FablePlanStageSchema>;

export const FablePlanStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('timed_out'),
  Type.Literal('cancelled'),
  Type.Literal('interrupted'),
]);
export type FablePlanStatus = Static<typeof FablePlanStatusSchema>;

export const FablePlanStartSchema = Type.Object(
  {
    requester: Type.Literal(FABLE_PLAN_REQUESTER),
    operationId: OperationIdSchema,
    runtime: Type.Literal(FABLE_PLAN_RUNTIME),
    model: Type.Literal(FABLE_PLAN_MODEL),
    profile: Type.Literal(FABLE_PLAN_PROFILE),
    packet: FablePlanPacketSchema,
  },
  { additionalProperties: false },
);
export type FablePlanStartPayload = Static<typeof FablePlanStartSchema>;

export const FablePlanStartedSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    runId: RunIdSchema,
    stage: Type.Union([Type.Literal('draft'), Type.Literal('review')]),
  },
  { additionalProperties: false },
);
export type FablePlanStartedPayload = Static<typeof FablePlanStartedSchema>;

export const FablePlanProgressSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    runId: RunIdSchema,
    stage: Type.Union([Type.Literal('draft'), Type.Literal('review')]),
    status: Type.String({ minLength: 1, maxLength: MAX_STATUS_LENGTH }),
    durationMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type FablePlanProgressPayload = Static<typeof FablePlanProgressSchema>;

export const FablePlanResultSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    status: FablePlanStatusSchema,
    stage: FablePlanStageSchema,
    draft: Type.Optional(Type.String({ maxLength: MAX_OUTPUT_LENGTH })),
    review: Type.Optional(Type.String({ maxLength: MAX_OUTPUT_LENGTH })),
    draftRunId: Type.Optional(RunIdSchema),
    reviewRunId: Type.Optional(RunIdSchema),
    durationMs: Type.Integer({ minimum: 0 }),
    errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ERROR_CODE_LENGTH })),
  },
  { additionalProperties: false },
);
export type FablePlanResultPayload = Static<typeof FablePlanResultSchema>;

export const FablePlanCancelSchema = Type.Object(
  {
    requester: Type.Literal(FABLE_PLAN_REQUESTER),
    operationId: OperationIdSchema,
    reason: Type.String({ minLength: 1, maxLength: MAX_STATUS_LENGTH }),
  },
  { additionalProperties: false },
);
export type FablePlanCancelPayload = Static<typeof FablePlanCancelSchema>;

export interface DoomFablePlanService {
  readonly sessionId: string;
  readonly generation: string;
  start(request: FablePlanStartPayload, signal: AbortSignal): Promise<FablePlanResultPayload>;
  cancel(request: FablePlanCancelPayload): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/fable-plan': DoomFablePlanService;
  }
}

export function readDoomFablePlanService(ctx: Context): DoomFablePlanService | undefined {
  return ctx.get(DOOM_FABLE_PLAN_SERVICE) as DoomFablePlanService | undefined;
}
