import { MAX_QUESTIONS, MIN_OPTIONS, type QuestionParams, RESERVED_LABELS } from '../schemas/questionnaire.js';
import type { QuestionnaireError } from '../types/questionnaire.js';

export const ERROR_NO_QUESTIONS = 'Error: At least one question is required';
export const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
export const ERROR_DUPLICATE_QUESTION = 'Error: Question text must be unique within an invocation';
export const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(', ')})`;
export const ERROR_DUPLICATE_OPTION_LABEL = 'Error: Option labels must be unique within a question';

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

const reservedLabels = new Set<string>(RESERVED_LABELS);

export function validateQuestionnaire(params: QuestionParams): ValidationResult {
  if (params.questions.length === 0) {
    return { ok: false, error: 'no_questions', message: ERROR_NO_QUESTIONS };
  }
  if (params.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: 'too_many_questions', message: ERROR_TOO_MANY_QUESTIONS };
  }

  const seenQuestions = new Set<string>();
  for (const question of params.questions) {
    if (seenQuestions.has(question.question)) {
      return { ok: false, error: 'duplicate_question', message: ERROR_DUPLICATE_QUESTION };
    }
    seenQuestions.add(question.question);
  }

  for (const question of params.questions) {
    if (question.options.length < MIN_OPTIONS) {
      return { ok: false, error: 'empty_options', message: ERROR_TOO_FEW_OPTIONS };
    }
    const seenLabels = new Set<string>();
    for (const option of question.options) {
      if (reservedLabels.has(option.label)) {
        return { ok: false, error: 'reserved_label', message: ERROR_RESERVED_LABEL };
      }
      if (seenLabels.has(option.label)) {
        return {
          ok: false,
          error: 'duplicate_option_label',
          message: ERROR_DUPLICATE_OPTION_LABEL,
        };
      }
      seenLabels.add(option.label);
    }
  }

  return { ok: true };
}
