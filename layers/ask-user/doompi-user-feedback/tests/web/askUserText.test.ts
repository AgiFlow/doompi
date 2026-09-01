import { describe, expect, it } from 'vitest';
import { askCallSummary, askResultView } from '../../src/web/askUserText.ts';

describe('the ask_user_question card text', () => {
  it('counts the questions and lists their headers', () => {
    expect(askCallSummary({})).toEqual({ count: '0 questions', headers: '' });
    expect(askCallSummary({ questions: [{ question: 'q', header: 'Auth' }] })).toEqual({
      count: '1 question',
      headers: 'Auth',
    });
    expect(
      askCallSummary({ questions: [{ question: 'a', header: 'One' }, { question: 'b', header: 'Two' }, 'junk'] }),
    ).toEqual({ count: '2 questions', headers: 'One, Two' });
  });

  it('chooses the body the TUI renderResult would', () => {
    expect(askResultView(undefined, 'raw')).toEqual({ kind: 'text', text: 'raw' });
    expect(askResultView({ answers: [], cancelled: true }, '')).toEqual({ kind: 'cancelled' });
    expect(askResultView({ answers: [], cancelled: false, delivery: 'voice', voicePrompt: 'Say it' }, '')).toEqual({
      kind: 'voice',
      prompt: 'Say it',
    });
    expect(
      askResultView(
        {
          answers: [
            { questionIndex: 0, question: 'Which?', kind: 'option', answer: 'A' },
            { questionIndex: 1, question: 'Many?', kind: 'multi', answer: null, selected: ['x', 'y', 3] },
            { questionIndex: 2, question: 'Free?', kind: 'custom', answer: null },
          ],
          cancelled: false,
        },
        '',
      ),
    ).toEqual({
      kind: 'answers',
      answers: [
        { question: 'Which?', answer: 'A' },
        { question: 'Many?', answer: 'x, y' },
        { question: 'Free?', answer: '' },
      ],
    });
    expect(askResultView({ answers: [], cancelled: false }, '')).toEqual({ kind: 'answers', answers: [] });
  });
});
