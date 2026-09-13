import { describe, expect, it, vi } from 'vitest';

import type { QuestionParams } from '../../src/schemas/questionnaire';
import { runQuestionnaire, type QuestionnaireInteraction } from '../../src/services/questionnaireService';
import { encodeAnswerEnvelope } from '../../src/types/askUserWire';

const params: QuestionParams = {
  questions: [
    {
      question: 'Choose one?',
      header: 'One',
      options: [
        { label: 'Alpha', description: 'First.', preview: 'alpha preview' },
        { label: 'Beta', description: 'Second.' },
      ],
    },
  ],
};

function interaction(select: () => Promise<string | undefined>): QuestionnaireInteraction {
  return {
    select: vi.fn(select),
    input: vi.fn(async () => undefined),
  };
}

describe('questionnaire interaction service', () => {
  it('accepts a rich answer envelope through the shared select callback', async () => {
    const select = vi.fn(async () =>
      encodeAnswerEnvelope([{ questionIndex: 0, question: 'Choose one?', kind: 'option', answer: 'Alpha' }]),
    );

    await expect(runQuestionnaire(interaction(select), params)).resolves.toEqual({
      answers: [
        {
          questionIndex: 0,
          question: 'Choose one?',
          kind: 'option',
          answer: 'Alpha',
          preview: 'alpha preview',
        },
      ],
      cancelled: false,
    });
    expect(select).toHaveBeenCalledOnce();
  });

  it('keeps an ordinary option label on the shared select path', async () => {
    const select = vi.fn(async () => 'Beta');

    await expect(runQuestionnaire(interaction(select), params)).resolves.toEqual({
      answers: [
        {
          questionIndex: 0,
          question: 'Choose one?',
          kind: 'option',
          answer: 'Beta',
        },
      ],
      cancelled: false,
    });
  });
});
