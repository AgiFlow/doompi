/**
 * The questionnaire the cockpit is filling in, as a value.
 *
 * Apart from React so the unit suite covers it without a DOM, the same way
 * askUserText.ts is. The questions come from the running tool call's
 * arguments, which are wire JSON: the shapes narrowed here mirror
 * src/schemas/questionnaire.ts, which a browser module may not import.
 *
 * Everything is held here until the reader submits, which is the whole point.
 * A step the reader goes back to still has what they chose, and the agent is
 * asked once rather than once per question.
 */
import type { QuestionAnswer } from '../types/questionnaire.ts';

/** The row every question gets, so a reader always has a way past a bad set of options. */
export const CUSTOM_LABEL = 'Type something.';

export interface PromptOption {
  label: string;
  description: string;
  preview?: string;
}

export interface PromptQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: PromptOption[];
}

export interface QuestionDraft {
  /** Chosen option labels: at most one unless the question is multiSelect. */
  selected: string[];
  /** Text typed in place of an option; null while the reader has not typed any. */
  custom: string | null;
  notes: string;
}

export type QuestionnaireDraft = readonly QuestionDraft[];

const EMPTY_ENTRY: QuestionDraft = { selected: [], custom: null, notes: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOption(value: unknown): PromptOption | null {
  if (!isRecord(value)) return null;
  const label = asString(value.label);
  if (label === '') return null;
  const preview = asString(value.preview);
  return { label, description: asString(value.description), ...(preview === '' ? {} : { preview }) };
}

/** The questions as the tool was called with them; an unreadable call yields none. */
export function readPromptQuestions(args: Readonly<Record<string, unknown>>): PromptQuestion[] {
  if (!Array.isArray(args.questions)) return [];
  return args.questions.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const question = asString(entry.question);
    if (question === '') return [];
    const options = (Array.isArray(entry.options) ? entry.options : []).flatMap((option) => {
      const read = readOption(option);
      return read === null ? [] : [read];
    });
    return [{ question, header: asString(entry.header), multiSelect: entry.multiSelect === true, options }];
  });
}

export function emptyDraft(count: number): QuestionnaireDraft {
  return Array.from({ length: count }, () => EMPTY_ENTRY);
}

export function draftEntry(draft: QuestionnaireDraft, index: number): QuestionDraft {
  return draft[index] ?? EMPTY_ENTRY;
}

function withEntry(draft: QuestionnaireDraft, index: number, patch: Partial<QuestionDraft>): QuestionnaireDraft {
  if (index < 0 || index >= draft.length) return draft;
  return draft.map((entry, position) => (position === index ? { ...entry, ...patch } : entry));
}

/**
 * Picks an option. A single-select question replaces its choice; a multiSelect
 * one toggles. Either way the typed answer is dropped, because an option and
 * free text are two answers to the same question and only one can be sent.
 */
export function chooseOption(
  draft: QuestionnaireDraft,
  index: number,
  label: string,
  multiSelect: boolean,
): QuestionnaireDraft {
  const current = draftEntry(draft, index).selected;
  const selected = multiSelect
    ? current.includes(label)
      ? current.filter((entry) => entry !== label)
      : [...current, label]
    : [label];
  return withEntry(draft, index, { selected, custom: null });
}

/** Types an answer instead of choosing one; null returns to the options. */
export function setCustom(draft: QuestionnaireDraft, index: number, custom: string | null): QuestionnaireDraft {
  return withEntry(draft, index, { custom, selected: [] });
}

export function setNotes(draft: QuestionnaireDraft, index: number, notes: string): QuestionnaireDraft {
  return withEntry(draft, index, { notes });
}

export function isAnswered(entry: QuestionDraft): boolean {
  return entry.selected.length > 0 || (entry.custom !== null && entry.custom.trim() !== '');
}

/** The next question still needing an answer, searching after `from` first; -1 when none is left. */
export function nextUnanswered(draft: QuestionnaireDraft, from: number): number {
  const after = draft.findIndex((entry, index) => index > from && !isAnswered(entry));
  return after >= 0 ? after : draft.findIndex((entry) => !isAnswered(entry));
}

export function isComplete(draft: QuestionnaireDraft): boolean {
  return draft.length > 0 && draft.every(isAnswered);
}

/**
 * The answers as the tool reads them back. `preview` is left off: the session
 * half looks it up from the option it declared, so sending one here would only
 * be a claim it has to ignore.
 */
export function draftAnswers(questions: readonly PromptQuestion[], draft: QuestionnaireDraft): QuestionAnswer[] {
  return questions.flatMap((question, index): QuestionAnswer[] => {
    const entry = draftEntry(draft, index);
    if (!isAnswered(entry)) return [];
    const notes = entry.notes.trim();
    const base = { questionIndex: index, question: question.question, ...(notes === '' ? {} : { notes }) };
    if (entry.custom !== null && entry.custom.trim() !== '') {
      return [{ ...base, kind: 'custom' as const, answer: entry.custom }];
    }
    if (question.multiSelect) {
      return [{ ...base, kind: 'multi' as const, answer: null, selected: [...entry.selected] }];
    }
    return [{ ...base, kind: 'option' as const, answer: entry.selected[0] ?? null }];
  });
}
