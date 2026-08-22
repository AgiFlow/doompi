import { type Static, Type } from 'typebox';

export const ReadParamsSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to read.' }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: 'One-based line offset.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum number of lines to return.' })),
});

export type ReadParams = Static<typeof ReadParamsSchema>;
