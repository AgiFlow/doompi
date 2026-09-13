import { defineDoomPluginMethod } from '@agimon-ai/doompi-core/plugin-protocol';
import { Type } from 'typebox';

export const voiceControlMethod = defineDoomPluginMethod({
  service: 'voice',
  method: 'control',
  scope: 'session',
  direction: 'client-to-server',
  input: Type.Object(
    {
      action: Type.Union(
        ['status', 'manual', 'activate', 'deactivate', 'mute', 'unmute', 'interrupt', 'transfer'].map((value) =>
          Type.Literal(value),
        ),
      ),
      target: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      state: Type.String(),
      mode: Type.String(),
      manual: Type.String(),
      muted: Type.Boolean(),
      error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
});
