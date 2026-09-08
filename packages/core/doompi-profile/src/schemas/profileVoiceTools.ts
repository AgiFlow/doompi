import { VOICE_TOOL_MAX_IDENTIFIER_LENGTH } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { type Static, Type } from 'typebox';

/**
 * The profile axis as one voice capability.
 *
 * Modelled on the major-mode capability rather than the domains pair: a profile
 * is a single name, so listing and switching fit one discriminated input and the
 * selected value rides the shared reload handoff instead of a second store.
 */
export const PROFILE_VOICE_TOOL_NAME = 'profile';

const PROFILE_NAME_SCHEMA = Type.String({
  minLength: 1,
  maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
});

export const PROFILE_VOICE_INPUT_SCHEMA = Type.Union([
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('switch'), profile: PROFILE_NAME_SCHEMA }, { additionalProperties: false }),
]);

export const PROFILE_VOICE_RESULT_SCHEMA = Type.Union([
  Type.Object(
    {
      status: Type.Literal('listed'),
      current: Type.Optional(PROFILE_NAME_SCHEMA),
      profiles: Type.Array(
        Type.Object(
          {
            name: PROFILE_NAME_SCHEMA,
            description: Type.String(),
            displayName: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal('unchanged'),
      profile: PROFILE_NAME_SCHEMA,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal('queued'),
      profile: PROFILE_NAME_SCHEMA,
      stopBatch: Type.Literal('session-reload'),
    },
    { additionalProperties: false },
  ),
]);

export type ProfileVoiceInput = Static<typeof PROFILE_VOICE_INPUT_SCHEMA>;
export type ProfileVoiceResult = Static<typeof PROFILE_VOICE_RESULT_SCHEMA>;
