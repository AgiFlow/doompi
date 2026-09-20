import { Type } from 'typebox';

export const searchSkillsParameters = Type.Object({ query: Type.Optional(Type.String()) });
export const loadSkillParameters = Type.Object({ name: Type.String() });
