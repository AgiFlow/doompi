import { type Static, Type } from 'typebox';

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const RESERVED_LABELS = ['Other', 'Type something.', 'Next'] as const;

export const OptionSchema = Type.Object(
  {
    label: Type.String({
      maxLength: MAX_LABEL_LENGTH,
      description: 'MAX 60 CHARACTERS — hard limit. Concise option label shown to the user, ideally 1-5 words.',
    }),
    description: Type.String({
      description: 'Explanation of what the option means and its important trade-offs.',
    }),
    preview: Type.Optional(
      Type.String({ description: 'Optional markdown preview rendered while this option is focused.' }),
    ),
  },
  { additionalProperties: false },
);

export const QuestionSchema = Type.Object(
  {
    question: Type.String({ description: 'The complete, clear question to ask the user.' }),
    header: Type.String({
      maxLength: MAX_HEADER_LENGTH,
      description: 'MAX 16 CHARACTERS — short label used when navigating several questions.',
    }),
    options: Type.Array(OptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: 'The 2-4 choices offered for this question.',
    }),
    multiSelect: Type.Optional(
      Type.Boolean({ description: 'Allow more than one option to be selected.', default: false }),
    ),
  },
  { additionalProperties: false },
);

export const QuestionParamsSchema = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: 'Questions to ask the user (1-4 questions).',
    }),
  },
  { additionalProperties: false },
);

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;
