import { Type } from 'typebox';

export const McpHeadlessToolParameters = Type.Object({
  server: Type.String({ minLength: 1 }),
  tool: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
