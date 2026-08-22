import { type Static, Type } from 'typebox';

export const GrepParamsSchema = Type.Object({
  pattern: Type.String({ description: 'Regular expression or literal text to find.' }),
  path: Type.Optional(Type.String({ description: 'File or directory to search. Defaults to the working directory.' })),
  glob: Type.Optional(Type.String({ description: 'Glob filter for files to search.' })),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Match without case sensitivity.' })),
  literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal text.' })),
  context: Type.Optional(Type.Integer({ minimum: 0, description: 'Context lines around every match.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum number of matches.' })),
});

export type GrepParams = Static<typeof GrepParamsSchema>;
