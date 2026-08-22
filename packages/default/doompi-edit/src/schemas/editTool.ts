import { type Static, Type } from 'typebox';

export const HashlineRangeSchema = Type.Object({
  from: Type.String({ description: 'One inclusive starting anchor, for example 5#abc. Do not paste multiple lines.' }),
  to: Type.String({ description: 'One inclusive ending anchor, for example 8#def. Do not paste multiple lines.' }),
  content: Type.Optional(
    Type.Union([
      Type.String({ description: 'Replacement content. Empty content deletes the selected lines.' }),
      Type.Null({ description: 'Delete the selected lines.' }),
    ]),
  ),
});

export const EditParamsSchema = Type.Object({
  path: Type.String({ description: 'Path to the file returned by a compatible hashline read or grep tool.' }),
  hash: Type.String({ description: 'Eight-character exact-byte file tag returned by read or grep.' }),
  edits: Type.Array(HashlineRangeSchema, {
    minItems: 1,
    description: 'Non-overlapping inclusive ranges from the same original snapshot.',
  }),
});

export type HashlineRange = Static<typeof HashlineRangeSchema>;
export type EditParams = Static<typeof EditParamsSchema>;
