import { Type, type Static } from 'typebox';
import { VOICE_TOOL_MAX_DOMAIN_COUNT, VOICE_TOOL_MAX_IDENTIFIER_LENGTH } from '../constants/voiceTools';
import { MAX_SESSION_ID_LENGTH, MAX_TOKEN_LENGTH } from '../constants/voiceReloadHandoff';
export const VoiceReloadHandoffKindSchema = Type.Union([
  Type.Literal('domain-switch'),
  Type.Literal('major-mode-switch'),
  Type.Literal('profile-switch'),
]);

export type VoiceReloadHandoffKind = Static<typeof VoiceReloadHandoffKindSchema>;

export const VoiceReloadHandoffIdentitySchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
    hostGeneration: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
  },
  { additionalProperties: false },
);

export type VoiceReloadHandoffIdentity = Static<typeof VoiceReloadHandoffIdentitySchema>;

export const VoiceReloadHandoffRequestSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    kind: Type.Optional(VoiceReloadHandoffKindSchema),
    domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }), {
        maxItems: VOICE_TOOL_MAX_DOMAIN_COUNT,
      }),
    ),
    majorMode: Type.Optional(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH })),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH })),
  },
  { additionalProperties: false },
);

export const VoiceReloadHandoffSchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: MAX_TOKEN_LENGTH }),
    sessionId: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
    hostGeneration: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
    operationId: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    kind: VoiceReloadHandoffKindSchema,
    domains: Type.Array(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }), {
      maxItems: VOICE_TOOL_MAX_DOMAIN_COUNT,
    }),
    majorMode: Type.Optional(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH })),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH })),
    createdAt: Type.Integer({ minimum: 0 }),
    expiresAt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type VoiceReloadHandoff = Static<typeof VoiceReloadHandoffSchema>;
