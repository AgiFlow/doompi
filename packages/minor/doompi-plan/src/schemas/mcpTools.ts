import { Type } from 'typebox';

const markdown = Type.String({ minLength: 1 });

export const remoteWritePlanParameters = Type.Object({ markdown }, { additionalProperties: false });
export const writePlanParameters = Type.Object({ markdown: Type.Optional(markdown) }, { additionalProperties: false });
