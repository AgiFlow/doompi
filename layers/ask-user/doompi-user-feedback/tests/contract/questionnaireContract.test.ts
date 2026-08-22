import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type QuestionParams,
  QuestionParamsSchema,
} from '../../src/schemas/questionnaire.js';
import {
  buildQuestionnaireResponse,
  DECLINE_MESSAGE,
  ENVELOPE_PREFIX,
  ENVELOPE_SUFFIX,
} from '../../src/services/responseService.js';
import { validateQuestionnaire } from '../../src/services/validationService.js';

function option(label: string) {
  return { label, description: `${label} description` };
}

function question(questionText: string, labels = ['One', 'Two']) {
  return {
    question: questionText,
    header: 'Choice',
    options: labels.map(option),
  };
}

function unchecked(questions: unknown[]): QuestionParams {
  return { questions } as QuestionParams;
}

describe('ask_user_question public contract', () => {
  it('pins schema limits for questions, options, headers, and labels', () => {
    const valid = { questions: [question('Choose?')] };
    expect(Check(QuestionParamsSchema, valid)).toBe(true);
    expect(Check(QuestionParamsSchema, { questions: [] })).toBe(false);
    expect(
      Check(QuestionParamsSchema, {
        questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_value, index) => question(`Question ${index}?`)),
      }),
    ).toBe(false);
    expect(
      Check(QuestionParamsSchema, {
        questions: [
          question(
            'Choose?',
            Array.from({ length: MIN_OPTIONS - 1 }, () => 'One'),
          ),
        ],
      }),
    ).toBe(false);
    expect(
      Check(QuestionParamsSchema, {
        questions: [
          question(
            'Choose?',
            Array.from({ length: MAX_OPTIONS + 1 }, (_value, index) => `Option ${index}`),
          ),
        ],
      }),
    ).toBe(false);
    expect(
      Check(QuestionParamsSchema, {
        questions: [{ ...question('Choose?'), header: 'h'.repeat(MAX_HEADER_LENGTH + 1) }],
      }),
    ).toBe(false);
    expect(
      Check(QuestionParamsSchema, {
        questions: [question('Choose?', ['x'.repeat(MAX_LABEL_LENGTH + 1), 'Two'])],
      }),
    ).toBe(false);
  });

  it('validates guards in the compatibility order', () => {
    expect(validateQuestionnaire(unchecked([]))).toMatchObject({ error: 'no_questions' });
    expect(
      validateQuestionnaire(
        unchecked(Array.from({ length: MAX_QUESTIONS + 1 }, (_value, index) => question(`Question ${index}?`))),
      ),
    ).toMatchObject({ error: 'too_many_questions' });
    expect(
      validateQuestionnaire(
        unchecked([
          { ...question('Duplicate?'), options: [] },
          { ...question('Duplicate?'), options: [] },
        ]),
      ),
    ).toMatchObject({ error: 'duplicate_question' });
    expect(validateQuestionnaire(unchecked([{ ...question('Empty?'), options: [] }]))).toMatchObject({
      error: 'empty_options',
    });
    expect(
      validateQuestionnaire(unchecked([question('Reserved?', ['Type something.', 'Type something.'])])),
    ).toMatchObject({ error: 'reserved_label' });
    expect(validateQuestionnaire(unchecked([question('Duplicate options?', ['Same', 'Same'])]))).toMatchObject({
      error: 'duplicate_option_label',
    });
    expect(validateQuestionnaire(unchecked([question('Valid?')]))).toEqual({ ok: true });
  });

  it('formats ordered answers, previews, notes, and multi-select values', () => {
    const params: QuestionParams = {
      questions: [question('First?'), { ...question('Second?'), multiSelect: true }],
    };
    const response = buildQuestionnaireResponse(
      {
        cancelled: false,
        answers: [
          {
            questionIndex: 1,
            question: 'Second?',
            kind: 'multi',
            answer: null,
            selected: ['One', 'Two'],
          },
          {
            questionIndex: 0,
            question: 'First?',
            kind: 'option',
            answer: 'One',
            preview: 'preview body',
            notes: 'user note',
          },
        ],
      },
      params,
    );

    expect(response.content[0]?.text).toBe(
      `${ENVELOPE_PREFIX} "First?"="One". selected preview: preview body. user notes: user note. "Second?"="One, Two". ${ENVELOPE_SUFFIX}`,
    );
    expect(response.details.cancelled).toBe(false);
  });

  it('uses one decline envelope while preserving partial cancellation details', () => {
    const params: QuestionParams = { questions: [question('First?'), question('Second?')] };
    const partial = {
      questionIndex: 0,
      question: 'First?',
      kind: 'custom' as const,
      answer: 'partly answered',
    };

    const response = buildQuestionnaireResponse({ answers: [partial], cancelled: true }, params);

    expect(response.content).toEqual([{ type: 'text', text: DECLINE_MESSAGE }]);
    expect(response.details).toEqual({ answers: [partial], cancelled: true });
    expect(buildQuestionnaireResponse(undefined, params).content[0]?.text).toBe(DECLINE_MESSAGE);
    expect(buildQuestionnaireResponse({ answers: [], cancelled: false }, params).content[0]?.text).toBe(
      DECLINE_MESSAGE,
    );
  });
});
