import { Type } from 'typebox';

export const loadContextParameters = Type.Object({}, { additionalProperties: false });
export const renameThreadParameters = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
