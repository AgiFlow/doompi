import type { QuestionParams } from '../schemas/questionnaire.js';
import type { QuestionAnswer, QuestionnaireResult, ToolTextResult } from '../types/questionnaire.js';

export const DECLINE_MESSAGE = 'User declined to answer questions';
export const ENVELOPE_PREFIX = 'User has answered your questions:';
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
export const NO_INPUT_PLACEHOLDER = '(no input)';

export function buildToolResult(text: string, details: QuestionnaireResult): ToolTextResult {
  return { content: [{ type: 'text', text }], details };
}

export function formatAnswer(answer: QuestionAnswer): string {
  if (answer.kind === 'multi') {
    return answer.selected && answer.selected.length > 0 ? answer.selected.join(', ') : NO_INPUT_PLACEHOLDER;
  }
  return answer.answer && answer.answer.length > 0 ? answer.answer : NO_INPUT_PLACEHOLDER;
}

export function buildAnswerSegment(answer: QuestionAnswer): string {
  const sections = [`"${answer.question}"="${formatAnswer(answer)}"`];
  if (answer.preview) sections.push(`selected preview: ${answer.preview}`);
  if (answer.notes) sections.push(`user notes: ${answer.notes}`);
  return `${sections.join('. ')}.`;
}

export function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: QuestionParams,
): ToolTextResult {
  if (!result || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result?.answers ?? [], cancelled: true });
  }

  const segments = params.questions.flatMap((_question, index) => {
    const answer = result.answers.find((candidate) => candidate.questionIndex === index);
    return answer ? [buildAnswerSegment(answer)] : [];
  });
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }

  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(' ')} ${ENVELOPE_SUFFIX}`, result);
}
