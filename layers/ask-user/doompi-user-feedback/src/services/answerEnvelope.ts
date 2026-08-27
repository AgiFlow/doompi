import type { QuestionData, QuestionParams } from '../schemas/questionnaire.js';
import type { AnswerKind, QuestionAnswer } from '../types/questionnaire.js';

/**
 * Read a whole-questionnaire answer envelope back against the questions it claims to answer.
 *
 * The envelope arrives on a select response, which is reader input rather than
 * anything the tool authored, so nothing in it is taken on trust: an index has
 * to name a question that was asked, a chosen label has to be one that
 * question offered, and free text is capped. An envelope that fails is refused
 * rather than repaired, because a half-read answer set reaches the model as
 * the reader's decision and there is no way to tell from there that part of it
 * was invented.
 *
 * `preview` is the clearest case: it is read from the option the tool
 * declared, never from the wire, so the model cannot be shown a preview that
 * was never offered.
 *
 * Host-neutral by construction: the questions and the payload both arrive as
 * arguments, so the same arguments always produce the same result.
 */
export const MAX_ANSWER_TEXT_LENGTH = 4000;

export type AnswerEnvelopeResult =
  | { readonly ok: true; readonly answers: QuestionAnswer[] }
  | { readonly ok: false; readonly reason: string };

const ANSWER_KINDS: readonly string[] = ['option', 'custom', 'multi'] satisfies readonly AnswerKind[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, MAX_ANSWER_TEXT_LENGTH);
}

/** One answer, rebuilt from the question it names rather than copied off the wire. */
function readAnswer(entry: unknown, params: QuestionParams, seen: Set<number>): QuestionAnswer | string {
  if (!isRecord(entry)) return 'an answer was not an object';
  const questionIndex = entry.questionIndex;
  if (typeof questionIndex !== 'number' || !Number.isInteger(questionIndex)) {
    return 'an answer carried no question index';
  }
  const question: QuestionData | undefined = params.questions[questionIndex];
  if (question === undefined) return `no question ${String(questionIndex)} was asked`;
  if (seen.has(questionIndex)) return `question ${String(questionIndex)} was answered twice`;
  seen.add(questionIndex);

  const kind = entry.kind;
  if (typeof kind !== 'string' || !ANSWER_KINDS.includes(kind)) {
    return `question ${String(questionIndex)} carried an unknown answer kind`;
  }
  const notes = optionalNote(entry.notes);
  const base = { questionIndex, question: question.question, ...(notes === undefined ? {} : { notes }) };

  if (kind === 'multi') {
    const selected = entry.selected;
    if (!Array.isArray(selected)) return `question ${String(questionIndex)} selected nothing readable`;
    const labels = selected.filter((label): label is string => typeof label === 'string');
    if (labels.length !== selected.length) return `question ${String(questionIndex)} selected a non-label`;
    if (labels.some((label) => !question.options.some((option) => option.label === label))) {
      return `question ${String(questionIndex)} selected an option it was not offered`;
    }
    return { ...base, kind: 'multi', answer: null, selected: [...new Set(labels)] };
  }

  if (kind === 'option') {
    const label = entry.answer;
    const chosen = typeof label === 'string' ? question.options.find((option) => option.label === label) : undefined;
    if (chosen === undefined) return `question ${String(questionIndex)} chose an option it was not offered`;
    // From the option the tool declared, so a preview the reader never saw
    // cannot be put in the model's mouth.
    return { ...base, kind: 'option', answer: chosen.label, ...(chosen.preview ? { preview: chosen.preview } : {}) };
  }

  const typed = entry.answer;
  if (typeof typed !== 'string') return `question ${String(questionIndex)} typed nothing readable`;
  return { ...base, kind: 'custom', answer: typed.slice(0, MAX_ANSWER_TEXT_LENGTH) };
}

export function readAnswerEnvelope(payload: unknown, params: QuestionParams): AnswerEnvelopeResult {
  if (!isRecord(payload) || !Array.isArray(payload.answers)) return { ok: false, reason: 'no answers were carried' };
  if (payload.answers.length === 0) return { ok: false, reason: 'no answers were carried' };
  if (payload.answers.length > params.questions.length) return { ok: false, reason: 'more answers than questions' };

  const seen = new Set<number>();
  const answers: QuestionAnswer[] = [];
  for (const entry of payload.answers) {
    const answer = readAnswer(entry, params, seen);
    if (typeof answer === 'string') return { ok: false, reason: answer };
    answers.push(answer);
  }
  // The model reads them in the order it asked, whatever order they arrived in.
  answers.sort((left, right) => left.questionIndex - right.questionIndex);
  return { ok: true, answers };
}
