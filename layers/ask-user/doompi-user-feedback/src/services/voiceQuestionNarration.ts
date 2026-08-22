import { MAX_NARRATION_TEXT_CHARACTERS } from '@agimon-ai/doompi-extension-contracts/narration';
import type { QuestionParams } from '../schemas/questionnaire.js';

const MAX_QUESTION_CHARACTERS = 240;
const MAX_OPTION_CHARACTERS = 80;
const PATH_PATTERN = /\/(?:Users|home|private|tmp|var)\/[^\s,;:]+/gu;
const TOKEN_PATTERN = /\b(?:sk|api|token|key)[-_][A-Za-z0-9_-]{12,}\b/giu;
const CODE_PATTERN = /`[^`]*`|<\/?[A-Za-z][^>]*>|\$\([^)]*\)|\{[^}]*\}/gu;
const SAFE_FALLBACK = 'I need your answer to the questions shown in the conversation.';

function takeCharacters(text: string, maximum: number): string {
  return Array.from(text).slice(0, maximum).join('').trim();
}

export function sanitizeVoiceQuestionText(text: string, maximum: number): string {
  const withoutControls = Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  }).join('');
  return takeCharacters(
    withoutControls
      .replace(PATH_PATTERN, ' ')
      .replace(TOKEN_PATTERN, ' ')
      .replace(CODE_PATTERN, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    maximum,
  );
}

function spokenQuestion(params: QuestionParams, questionIndex: number): string {
  const question = params.questions[questionIndex];
  if (!question) return '';
  const position = questionIndex + 1;
  const prompt =
    sanitizeVoiceQuestionText(question.question, MAX_QUESTION_CHARACTERS) || `Question ${position} needs your choice`;
  const labels = question.options.map((option, optionIndex) => {
    const label = sanitizeVoiceQuestionText(option.label, MAX_OPTION_CHARACTERS);
    return `${optionIndex + 1}, ${label || `option ${optionIndex + 1}`}`;
  });
  const selection = question.multiSelect ? 'You may choose more than one option.' : 'Please choose one option.';
  return `Question ${position}: ${prompt}. Options: ${labels.join('; ')}. ${selection} You may also answer in your own words.`;
}

export function buildVoiceQuestionNarration(params: QuestionParams): string {
  const questions = params.questions.map((_question, index) => spokenQuestion(params, index));
  const combined = sanitizeVoiceQuestionText(questions.join(' '), MAX_NARRATION_TEXT_CHARACTERS);
  return combined || SAFE_FALLBACK;
}
