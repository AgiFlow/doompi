import { Type, type Static } from 'typebox';

import {
  VOICE_TOOL_MAX_TIMEOUT_MS,
  VOICE_TOOL_MAX_BATCH_ITEMS,
  VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
  VOICE_TOOL_MAX_LABEL_LENGTH,
  VOICE_TOOL_MAX_DESCRIPTION_LENGTH,
  VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH,
  SAFE_IDENTIFIER,
  SAFE_NAME,
  MAX_ORDER,
} from '../constants/voiceTools';
export const VoiceToolDescriptorSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_IDENTIFIER.source }),
    id: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_IDENTIFIER.source }),
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_NAME.source }),
    label: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_LABEL_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_DESCRIPTION_LENGTH }),
    order: Type.Integer({ minimum: 0, maximum: MAX_ORDER }),
    inputSchema: Type.Unknown(),
    resultSchema: Type.Unknown(),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: VOICE_TOOL_MAX_TIMEOUT_MS })),
  },
  { additionalProperties: false },
);

export const VoiceToolBatchCallSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
      pattern: SAFE_NAME.source,
      description: 'Capability name exactly as describe_voice_tools reported it.',
    }),
    input: Type.Unknown({
      description:
        'Arguments for this capability, shaped by the input_schema that describe_voice_tools returns when called with names. Pass an empty object for a capability that takes none.',
    }),
  },
  { additionalProperties: false },
);

export type VoiceToolBatchCall = Static<typeof VoiceToolBatchCallSchema>;

export const VoiceToolDescribeInputSchema = Type.Object(
  {
    names: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_NAME.source }),
        {
          maxItems: VOICE_TOOL_MAX_BATCH_ITEMS,
          description:
            'Capabilities to describe in full, including their input schemas. Omit to list every registered capability by name and description only.',
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export type VoiceToolDescribeInput = Static<typeof VoiceToolDescribeInputSchema>;

export const VoiceToolCatalogTokenSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Opaque catalog token from the most recent describe_voice_tools result, copied verbatim. It is invalidated whenever a capability registers or deregisters and whenever autonomous voice is activated or deactivated.',
});

export type VoiceToolCatalogToken = Static<typeof VoiceToolCatalogTokenSchema>;

export const VoiceToolUseInputSchema = Type.Object(
  {
    catalogToken: VoiceToolCatalogTokenSchema,
    calls: Type.Array(VoiceToolBatchCallSchema, {
      minItems: 1,
      maxItems: VOICE_TOOL_MAX_BATCH_ITEMS,
      description:
        'Capability calls to run in this order. All of them are validated before any of them run, so a single invalid call rejects the whole batch.',
    }),
  },
  { additionalProperties: false },
);

export type VoiceToolUseInput = Static<typeof VoiceToolUseInputSchema>;

export const VoiceToolErrorCodeSchema = Type.Union([
  Type.Literal('VOICE_TOOL_HOST_UNAVAILABLE'),
  Type.Literal('VOICE_TOOL_INACTIVE'),
  Type.Literal('VOICE_TOOL_STALE_SESSION'),
  Type.Literal('VOICE_TOOL_STALE_CATALOG'),
  Type.Literal('VOICE_TOOL_NOT_FOUND'),
  Type.Literal('VOICE_TOOL_NAME_CONFLICT'),
  Type.Literal('VOICE_TOOL_INVALID_INPUT'),
  Type.Literal('VOICE_TOOL_INVALID_RESULT'),
  Type.Literal('VOICE_TOOL_EXECUTION_FAILED'),
  Type.Literal('VOICE_TOOL_TIMEOUT'),
  Type.Literal('VOICE_TOOL_ABORTED'),
  Type.Literal('VOICE_TOOL_CANCELLED'),
  Type.Literal('VOICE_TOOL_REGISTRATION_DISPOSED'),
  Type.Literal('VOICE_TOOL_SESSION_SHUTDOWN'),
  Type.Literal('VOICE_TOOL_BATCH_STOPPED'),
  Type.Literal('VOICE_TOOL_RELOAD_QUEUED'),
  Type.Literal('VOICE_TOOL_INVALID_REQUEST'),
]);

export type VoiceToolErrorCode = Static<typeof VoiceToolErrorCodeSchema>;

export const VoiceToolErrorSchema = Type.Object(
  {
    code: VoiceToolErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH }),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type VoiceToolErrorPayload = Static<typeof VoiceToolErrorSchema>;

export const VoiceToolConflictDiagnosticSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    message: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH }),
    claims: Type.Array(
      Type.Object(
        {
          source: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
          id: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: VOICE_TOOL_MAX_BATCH_ITEMS },
    ),
  },
  { additionalProperties: false },
);

export type VoiceToolConflictDiagnostic = Static<typeof VoiceToolConflictDiagnosticSchema>;

export const VoiceToolCatalogEntrySchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    id: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    label: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_LABEL_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_DESCRIPTION_LENGTH }),
    order: Type.Integer({ minimum: 0, maximum: MAX_ORDER }),
    inputSchema: Type.Unknown(),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type VoiceToolCatalogEntry = Static<typeof VoiceToolCatalogEntrySchema>;

export const VoiceToolCatalogSnapshotSchema = Type.Object(
  {
    hostGeneration: Type.String({ minLength: 1, maxLength: 256 }),
    catalogRevision: Type.Integer({ minimum: 0 }),
    catalogToken: VoiceToolCatalogTokenSchema,
    tools: Type.Array(VoiceToolCatalogEntrySchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS * 8 }),
    conflicts: Type.Array(VoiceToolConflictDiagnosticSchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS * 8 }),
    unknownNames: Type.Array(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }), {
      maxItems: VOICE_TOOL_MAX_BATCH_ITEMS,
    }),
  },
  { additionalProperties: false },
);

export type VoiceToolCatalogSnapshot = Static<typeof VoiceToolCatalogSnapshotSchema>;

export const VoiceToolBatchItemResultSchema = Type.Object(
  {
    index: Type.Integer({ minimum: 0, maximum: VOICE_TOOL_MAX_BATCH_ITEMS }),
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('not_executed'),
      Type.Literal('preflight_failed'),
    ]),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(VoiceToolErrorSchema),
  },
  { additionalProperties: false },
);

export type VoiceToolBatchItemResult = Static<typeof VoiceToolBatchItemResultSchema>;

export const VoiceToolBatchResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('rejected'),
      Type.Literal('cancelled'),
      Type.Literal('stopped'),
    ]),
    catalogToken: VoiceToolCatalogTokenSchema,
    results: Type.Array(VoiceToolBatchItemResultSchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS }),
    errors: Type.Optional(Type.Array(VoiceToolErrorSchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS })),
  },
  { additionalProperties: false },
);

export type VoiceToolBatchResult = Static<typeof VoiceToolBatchResultSchema>;
