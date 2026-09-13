import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from './questionnaire';
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES = [
  `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions, you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
  `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself, reserved labels are rejected at runtime.`,
  'Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs), single-select only. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.',
  'Do not stack multiple ask_user_question calls back-to-back, group all clarifying questions into one invocation.',
];

export const ERROR_NO_UI = 'Error: UI not available (running in non-interactive mode)';
export const ERROR_NO_CUSTOM_UI =
  'Error: this client cannot render the questionnaire (custom UI is unavailable). The user never saw the questions, do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.';
export const ERROR_SESSION_LOAD_FAILED =
  'Error: the questionnaire UI failed to load. The user never saw the questions, do NOT treat this as a decline. Ask the questions as plain chat text instead.';
export const ERROR_SESSION_INACTIVE = 'Error: the questionnaire session is no longer active.';
