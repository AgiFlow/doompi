import { describe, expect, it } from 'vitest';
import {
  chooseOption,
  draftAnswers,
  draftEntry,
  emptyDraft,
  isAnswered,
  isComplete,
  nextUnanswered,
  type PromptQuestion,
  readPromptQuestions,
  setCustom,
  setNotes,
} from '../../src/web/questionnaireDraft.ts';

const args = {
  questions: [
    {
      question: 'Choose one?',
      header: 'One',
      options: [
        { label: 'Alpha', description: 'First.', preview: '# alpha' },
        { label: 'Beta', description: 'Second.' },
      ],
    },
    {
      question: 'Choose several?',
      header: 'Several',
      multiSelect: true,
      options: [
        { label: 'Gamma', description: 'Third.' },
        { label: 'Delta', description: 'Fourth.' },
      ],
    },
  ],
};

function questions(): PromptQuestion[] {
  return readPromptQuestions(args);
}

describe('reading the questions off the call', () => {
  it('keeps the labels, descriptions, previews and the multiSelect flag', () => {
    expect(questions()).toEqual([
      {
        question: 'Choose one?',
        header: 'One',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First.', preview: '# alpha' },
          { label: 'Beta', description: 'Second.' },
        ],
      },
      {
        question: 'Choose several?',
        header: 'Several',
        multiSelect: true,
        options: [
          { label: 'Gamma', description: 'Third.' },
          { label: 'Delta', description: 'Fourth.' },
        ],
      },
    ]);
  });

  it('yields nothing from a call it cannot read, rather than a half-built question', () => {
    expect(readPromptQuestions({})).toEqual([]);
    expect(readPromptQuestions({ questions: 'nope' })).toEqual([]);
    expect(readPromptQuestions({ questions: [{ header: 'no question text' }, 'junk'] })).toEqual([]);
    expect(readPromptQuestions({ questions: [{ question: 'q', options: [{ description: 'no label' }] }] })).toEqual([
      { question: 'q', header: '', multiSelect: false, options: [] },
    ]);
  });
});

describe('the questionnaire draft', () => {
  it('starts with nothing answered', () => {
    const draft = emptyDraft(2);
    expect(draft).toHaveLength(2);
    expect(draft.every((entry) => !isAnswered(entry))).toBe(true);
    expect(isComplete(draft)).toBe(false);
  });

  it('replaces a single-select choice and toggles a multiSelect one', () => {
    let draft = emptyDraft(2);
    draft = chooseOption(draft, 0, 'Alpha', false);
    draft = chooseOption(draft, 0, 'Beta', false);
    expect(draftEntry(draft, 0).selected).toEqual(['Beta']);

    draft = chooseOption(draft, 1, 'Gamma', true);
    draft = chooseOption(draft, 1, 'Delta', true);
    expect(draftEntry(draft, 1).selected).toEqual(['Gamma', 'Delta']);
    draft = chooseOption(draft, 1, 'Gamma', true);
    expect(draftEntry(draft, 1).selected).toEqual(['Delta']);
  });

  it('keeps what a step held when the reader goes back to it', () => {
    let draft = emptyDraft(2);
    draft = setNotes(chooseOption(draft, 0, 'Alpha', false), 0, 'because of the cache');
    draft = chooseOption(draft, 1, 'Gamma', true);

    // Coming back and choosing again changes only that step.
    draft = chooseOption(draft, 0, 'Beta', false);
    expect(draftEntry(draft, 0)).toEqual({ selected: ['Beta'], custom: null, notes: 'because of the cache' });
    expect(draftEntry(draft, 1).selected).toEqual(['Gamma']);
  });

  it('treats an option and typed text as two answers to the same question, never both', () => {
    let draft = chooseOption(emptyDraft(1), 0, 'Alpha', false);
    draft = setCustom(draft, 0, 'something else');
    expect(draftEntry(draft, 0)).toMatchObject({ selected: [], custom: 'something else' });

    draft = chooseOption(draft, 0, 'Alpha', false);
    expect(draftEntry(draft, 0)).toMatchObject({ selected: ['Alpha'], custom: null });
  });

  it('does not count an empty typed answer as answered', () => {
    expect(isAnswered(draftEntry(setCustom(emptyDraft(1), 0, '   '), 0))).toBe(false);
    expect(isAnswered(draftEntry(setCustom(emptyDraft(1), 0, 'x'), 0))).toBe(true);
  });

  it('leaves a draft untouched when the index names no question', () => {
    const draft = emptyDraft(1);
    expect(chooseOption(draft, 4, 'Alpha', false)).toBe(draft);
    expect(setNotes(draft, -1, 'note')).toBe(draft);
  });

  it('points at the next unanswered step, wrapping to one left behind', () => {
    let draft = emptyDraft(3);
    expect(nextUnanswered(draft, -1)).toBe(0);
    draft = chooseOption(draft, 1, 'Gamma', true);
    expect(nextUnanswered(draft, 1)).toBe(2);
    draft = chooseOption(draft, 2, 'Alpha', false);
    // Nothing after step 2, so it comes back for the one still open.
    expect(nextUnanswered(draft, 2)).toBe(0);
    draft = chooseOption(draft, 0, 'Alpha', false);
    expect(nextUnanswered(draft, 0)).toBe(-1);
    expect(isComplete(draft)).toBe(true);
  });

  it('builds the answers the tool reads back, without a preview it would ignore', () => {
    let draft = emptyDraft(2);
    draft = setNotes(chooseOption(draft, 0, 'Alpha', false), 0, '  mind the cache  ');
    draft = chooseOption(chooseOption(draft, 1, 'Gamma', true), 1, 'Delta', true);

    expect(draftAnswers(questions(), draft)).toEqual([
      { questionIndex: 0, question: 'Choose one?', kind: 'option', answer: 'Alpha', notes: 'mind the cache' },
      { questionIndex: 1, question: 'Choose several?', kind: 'multi', answer: null, selected: ['Gamma', 'Delta'] },
    ]);
  });

  it('reports a typed answer as one, and omits a step with no answer', () => {
    const draft = setCustom(emptyDraft(2), 0, 'neither of those');
    expect(draftAnswers(questions(), draft)).toEqual([
      { questionIndex: 0, question: 'Choose one?', kind: 'custom', answer: 'neither of those' },
    ]);
  });
});
