import { Type } from 'typebox';

export const sessionViewSchema = Type.Object(
  {
    sessionId: Type.String(),
    revision: Type.Integer({ minimum: 0 }),
    repositoryName: Type.String(),
    profile: Type.Union([Type.String(), Type.Null()]),
    majorMode: Type.String(),
    domains: Type.Array(Type.String()),
    layers: Type.Array(Type.String()),
    minorModes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
