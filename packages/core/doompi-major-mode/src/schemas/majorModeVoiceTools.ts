import { VOICE_TOOL_MAX_IDENTIFIER_LENGTH } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { type Static, Type } from 'typebox';

export const MAJOR_MODE_VOICE_TOOL_NAME = 'major_mode';

const MAJOR_MODE_INPUT_NAME_SCHEMA = Type.String({
  minLength: 1,
  maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
});
const CONFIGURED_NAME_SCHEMA = Type.String({ minLength: 1 });
const MAJOR_MODE_LAYERS_SCHEMA = Type.Array(CONFIGURED_NAME_SCHEMA);

export const MAJOR_MODE_VOICE_INPUT_SCHEMA = Type.Union([
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal('switch'),
      majorMode: MAJOR_MODE_INPUT_NAME_SCHEMA,
    },
    { additionalProperties: false },
  ),
]);

export const MAJOR_MODE_VOICE_RESULT_SCHEMA = Type.Union([
  Type.Object(
    {
      status: Type.Literal('listed'),
      current: CONFIGURED_NAME_SCHEMA,
      modes: Type.Array(
        Type.Object(
          {
            name: CONFIGURED_NAME_SCHEMA,
            description: Type.String({ minLength: 1 }),
            layers: MAJOR_MODE_LAYERS_SCHEMA,
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
      majorMode: CONFIGURED_NAME_SCHEMA,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal('queued'),
      majorMode: CONFIGURED_NAME_SCHEMA,
      stopBatch: Type.Literal('session-reload'),
    },
    { additionalProperties: false },
  ),
]);

export type MajorModeVoiceInput = Static<typeof MAJOR_MODE_VOICE_INPUT_SCHEMA>;
export type MajorModeVoiceResult = Static<typeof MAJOR_MODE_VOICE_RESULT_SCHEMA>;
