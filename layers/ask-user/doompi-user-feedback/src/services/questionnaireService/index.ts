import type { QuestionData, QuestionParams } from '../../schemas/questionnaire';
import { decodeAnswerEnvelope } from '../../types/askUserWire';
import type { QuestionAnswer, QuestionnaireResult } from '../../types/questionnaire';
import { readAnswerEnvelope } from '../answerEnvelope';

const CUSTOM_LABEL = 'Type something.';
const DONE_LABEL = 'Next';

export interface QuestionnaireInteraction {
  select(title: string, options: readonly string[], signal?: AbortSignal): Promise<string | undefined>;
  input(title: string, placeholder: string, signal?: AbortSignal): Promise<string | undefined>;
}

function cancelled(answers: QuestionAnswer[]): QuestionnaireResult {
  return { answers, cancelled: true };
}

/**
 * What a rich client replied, when it replied with the whole questionnaire.
 *
 * A client that can see the whole call answers every question at once rather
 * than walking this loop, so any select response may be an envelope instead of
 * a label. A response that is not one leaves the loop exactly as it was, which
 * is what keeps a plain RPC client working unchanged.
 */
interface EnvelopeSink {
  params: QuestionParams;
  /** Set once a select response carried the whole questionnaire; the loop stops and returns it. */
  result?: QuestionnaireResult;
}

/** True when this response was the whole set, in which case the sink now holds the answer. */
function takeEnvelope(sink: EnvelopeSink, selected: string | undefined): boolean {
  const read = decodeAnswerEnvelope(selected);
  if (read.kind === 'absent') return false;
  if (read.kind === 'malformed') {
    sink.result = { answers: [], cancelled: true, error: 'malformed_answers' };
    return true;
  }
  const envelope = readAnswerEnvelope(read.payload, sink.params);
  sink.result = envelope.ok
    ? { answers: envelope.answers, cancelled: false }
    : { answers: [], cancelled: true, error: 'malformed_answers' };
  return true;
}

async function askForCustomAnswer(
  interaction: QuestionnaireInteraction,
  question: QuestionData,
  questionIndex: number,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const answer = await interaction.input(question.question, 'Type your answer', signal);
  if (answer === undefined) return undefined;
  return {
    questionIndex,
    question: question.question,
    kind: 'custom',
    answer,
  };
}

async function askSingleChoice(
  interaction: QuestionnaireInteraction,
  question: QuestionData,
  questionIndex: number,
  sink: EnvelopeSink,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const labels = [...question.options.map((option) => option.label), CUSTOM_LABEL];
  const selected = await interaction.select(question.question, labels, signal);
  if (selected === undefined) return undefined;
  if (takeEnvelope(sink, selected)) return undefined;
  if (selected === CUSTOM_LABEL) {
    return askForCustomAnswer(interaction, question, questionIndex, signal);
  }
  const option = question.options.find((candidate) => candidate.label === selected);
  if (!option) return undefined;
  return {
    questionIndex,
    question: question.question,
    kind: 'option',
    answer: option.label,
    ...(option.preview ? { preview: option.preview } : {}),
  };
}

function multiChoiceLabels(question: QuestionData, selected: ReadonlySet<string>): string[] {
  const options = question.options.map((option) => {
    const marker = selected.has(option.label) ? '[x]' : '[ ]';
    return `${marker} ${option.label}`;
  });
  return [...options, CUSTOM_LABEL, DONE_LABEL];
}

function stripSelectionMarker(value: string): string {
  return value.replace(/^\[[ x]\]\s/u, '');
}

async function askMultipleChoice(
  interaction: QuestionnaireInteraction,
  question: QuestionData,
  questionIndex: number,
  sink: EnvelopeSink,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const selected = new Set<string>();
  while (!signal?.aborted) {
    const choice = await interaction.select(
      `${question.question} (choose options, then Next)`,
      multiChoiceLabels(question, selected),
      signal,
    );
    if (choice === undefined) return undefined;
    if (takeEnvelope(sink, choice)) return undefined;
    if (choice === CUSTOM_LABEL) {
      return askForCustomAnswer(interaction, question, questionIndex, signal);
    }
    if (choice === DONE_LABEL) {
      return {
        questionIndex,
        question: question.question,
        kind: 'multi',
        answer: null,
        selected: [...selected],
      };
    }
    const label = stripSelectionMarker(choice);
    if (!question.options.some((option) => option.label === label)) continue;
    if (selected.has(label)) selected.delete(label);
    else selected.add(label);
  }
  return undefined;
}

export async function runQuestionnaire(
  interaction: QuestionnaireInteraction,
  params: QuestionParams,
  signal?: AbortSignal,
  reportProgress?: (result: QuestionnaireResult) => void,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  const sink: EnvelopeSink = { params };
  for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex += 1) {
    if (signal?.aborted) return cancelled(answers);
    const question = params.questions[questionIndex];
    if (!question) continue;
    const answer = question.multiSelect
      ? await askMultipleChoice(interaction, question, questionIndex, sink, signal)
      : await askSingleChoice(interaction, question, questionIndex, sink, signal);
    // A client that answered everything at once ends the walk here; the loop
    // is only how a client that can see one question at a time gets through.
    if (sink.result !== undefined) {
      const whole = sink.result;
      if (!whole.cancelled) {
        reportProgress?.({ ...whole, answers: whole.answers.map((item) => ({ ...item })) });
      }
      return whole;
    }
    if (!answer) return cancelled(answers);
    answers.push(answer);
    reportProgress?.({ answers: answers.map((item) => ({ ...item })), cancelled: false });
  }
  return { answers, cancelled: false };
}
