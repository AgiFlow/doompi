import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { QuestionData, QuestionParams } from '../../schemas/questionnaire.js';
import type { QuestionAnswer, QuestionnaireResult } from '../../types/questionnaire.js';

const CUSTOM_LABEL = 'Type something.';
const DONE_LABEL = 'Next';

function cancelled(answers: QuestionAnswer[]): QuestionnaireResult {
  return { answers, cancelled: true };
}

async function askForCustomAnswer(
  context: ExtensionContext,
  question: QuestionData,
  questionIndex: number,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const answer = await context.ui.input(question.question, 'Type your answer', { signal });
  if (answer === undefined) return undefined;
  return {
    questionIndex,
    question: question.question,
    kind: 'custom',
    answer,
  };
}

async function askSingleChoice(
  context: ExtensionContext,
  question: QuestionData,
  questionIndex: number,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const labels = [...question.options.map((option) => option.label), CUSTOM_LABEL];
  const selected = await context.ui.select(question.question, labels, { signal });
  if (selected === undefined) return undefined;
  if (selected === CUSTOM_LABEL) {
    return askForCustomAnswer(context, question, questionIndex, signal);
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
  context: ExtensionContext,
  question: QuestionData,
  questionIndex: number,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const selected = new Set<string>();
  while (!signal?.aborted) {
    const choice = await context.ui.select(
      `${question.question} (choose options, then Next)`,
      multiChoiceLabels(question, selected),
      { signal },
    );
    if (choice === undefined) return undefined;
    if (choice === CUSTOM_LABEL) {
      return askForCustomAnswer(context, question, questionIndex, signal);
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

export async function runRpcQuestionnaire(
  context: ExtensionContext,
  params: QuestionParams,
  signal?: AbortSignal,
  reportProgress?: (result: QuestionnaireResult) => void,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex += 1) {
    if (signal?.aborted) return cancelled(answers);
    const question = params.questions[questionIndex];
    if (!question) continue;
    const answer = question.multiSelect
      ? await askMultipleChoice(context, question, questionIndex, signal)
      : await askSingleChoice(context, question, questionIndex, signal);
    if (!answer) return cancelled(answers);
    answers.push(answer);
    reportProgress?.({ answers: answers.map((item) => ({ ...item })), cancelled: false });
  }
  return { answers, cancelled: false };
}
