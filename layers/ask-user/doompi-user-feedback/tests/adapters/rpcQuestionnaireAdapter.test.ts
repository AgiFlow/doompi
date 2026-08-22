import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { runRpcQuestionnaire } from '../../src/adapters/pi/rpcQuestionnaireAdapter.js';
import type { QuestionParams } from '../../src/schemas/questionnaire.js';

function context(
  select: (...args: unknown[]) => Promise<string | undefined>,
  input: (...args: unknown[]) => Promise<string | undefined> = async () => undefined,
): ExtensionContext {
  return { ui: { select, input } } as unknown as ExtensionContext;
}

const single: QuestionParams = {
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

const multi: QuestionParams = {
  questions: [
    {
      question: 'Choose several?',
      header: 'Several',
      multiSelect: true,
      options: [
        { label: 'Alpha', description: 'First.' },
        { label: 'Beta', description: 'Second.' },
      ],
    },
  ],
};

describe('RPC questionnaire adapter', () => {
  it('returns a selected single option with its preview', async () => {
    const select = vi.fn(async () => 'Alpha');
    const report = vi.fn();

    const result = await runRpcQuestionnaire(context(select), single, undefined, report);

    expect(result).toEqual({
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
    expect(report).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('collects a custom answer and preserves cancellation when input is dismissed', async () => {
    const custom = await runRpcQuestionnaire(
      context(
        async () => 'Type something.',
        async () => 'A custom answer',
      ),
      single,
    );
    const dismissed = await runRpcQuestionnaire(
      context(
        async () => 'Type something.',
        async () => undefined,
      ),
      single,
    );

    expect(custom.answers[0]).toMatchObject({ kind: 'custom', answer: 'A custom answer' });
    expect(dismissed).toEqual({ answers: [], cancelled: true });
  });

  it('returns cancellation when selection is dismissed or does not map to an option', async () => {
    await expect(
      runRpcQuestionnaire(
        context(async () => undefined),
        single,
      ),
    ).resolves.toEqual({
      answers: [],
      cancelled: true,
    });
    await expect(
      runRpcQuestionnaire(
        context(async () => 'Unknown'),
        single,
      ),
    ).resolves.toEqual({
      answers: [],
      cancelled: true,
    });
  });

  it('toggles multi-select choices until Next and keeps insertion order', async () => {
    const choices = ['[ ] Alpha', '[ ] Beta', '[x] Alpha', 'Next'];
    const select = vi.fn(async () => choices.shift());

    const result = await runRpcQuestionnaire(context(select), multi);

    expect(result).toEqual({
      answers: [
        {
          questionIndex: 0,
          question: 'Choose several?',
          kind: 'multi',
          answer: null,
          selected: ['Beta'],
        },
      ],
      cancelled: false,
    });
    expect(select).toHaveBeenCalledTimes(4);
  });

  it('allows a custom response from a multi-select question', async () => {
    const result = await runRpcQuestionnaire(
      context(
        async () => 'Type something.',
        async () => 'Something else',
      ),
      multi,
    );

    expect(result.answers[0]).toMatchObject({ kind: 'custom', answer: 'Something else' });
  });

  it('ignores unknown multi-select rows and permits an empty Next result', async () => {
    const choices = ['unrecognized row', 'Next'];
    const result = await runRpcQuestionnaire(
      context(async () => choices.shift()),
      multi,
    );

    expect(result.answers[0]).toMatchObject({ kind: 'multi', selected: [] });
  });

  it('preserves earlier answers when a later question is cancelled', async () => {
    const combined: QuestionParams = {
      questions: [single.questions[0]!, { ...multi.questions[0]!, question: 'Second?' }],
    };
    const choices = ['Beta', undefined];
    const report = vi.fn();

    const result = await runRpcQuestionnaire(
      context(async () => choices.shift()),
      combined,
      undefined,
      report,
    );

    expect(result).toEqual({
      answers: [
        {
          questionIndex: 0,
          question: 'Choose one?',
          kind: 'option',
          answer: 'Beta',
        },
      ],
      cancelled: true,
    });
    expect(report).toHaveBeenCalledOnce();
  });

  it('does not open a dialog when already aborted', async () => {
    const abort = new AbortController();
    const select = vi.fn();
    abort.abort();

    await expect(runRpcQuestionnaire(context(select), single, abort.signal)).resolves.toEqual({
      answers: [],
      cancelled: true,
    });
    expect(select).not.toHaveBeenCalled();
  });
});
