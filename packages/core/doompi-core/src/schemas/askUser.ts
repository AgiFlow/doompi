import { type Static, Type } from 'typebox';

/** Namespaced Cordis events emitted by the ask-user provider. */
export const DOOM_ASK_USER_PROMPT_EVENT = 'doom/ask-user/prompt';
export const DOOM_ASK_USER_BLOCKED_EVENT = 'doom/ask-user/blocked';

const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 16;
const MAX_TEXT_LENGTH = 4_096;

export const AskUserPromptOptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
    description: Type.String({ maxLength: MAX_TEXT_LENGTH }),
    hasPreview: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AskUserPromptOption = Static<typeof AskUserPromptOptionSchema>;

export const AskUserPromptQuestionSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
    header: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
    multiSelect: Type.Boolean(),
    options: Type.Array(AskUserPromptOptionSchema, { maxItems: MAX_OPTIONS }),
  },
  { additionalProperties: false },
);
export type AskUserPromptQuestion = Static<typeof AskUserPromptQuestionSchema>;

export const AskUserPromptEventSchema = Type.Object(
  { questions: Type.Array(AskUserPromptQuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }) },
  { additionalProperties: false },
);
export type AskUserPromptEvent = Static<typeof AskUserPromptEventSchema>;

export const AskUserBlockedEventSchema = Type.Object({ active: Type.Boolean() }, { additionalProperties: false });
export type AskUserBlockedEvent = Static<typeof AskUserBlockedEventSchema>;

declare module '@deepseek-ai/cordis' {
  interface Events {
    'doom/ask-user/prompt'(event: AskUserPromptEvent): void;
    'doom/ask-user/blocked'(event: AskUserBlockedEvent): void;
  }
}
