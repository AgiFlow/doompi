export type AnswerKind = 'option' | 'custom' | 'multi';

export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: AnswerKind;
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

export type QuestionnaireError =
  | 'no_ui'
  | 'no_custom_ui'
  | 'no_questions'
  | 'empty_options'
  | 'too_many_questions'
  | 'duplicate_question'
  | 'duplicate_option_label'
  | 'reserved_label'
  | 'session_load_failed'
  | 'stale_module_cache'
  /** A client replied with an answer envelope that did not match the questions asked. */
  | 'malformed_answers';

export type ExternalEditResult =
  | { readonly status: 'complete'; readonly content: string }
  | { readonly status: 'failed'; readonly message: string };

export interface QuestionnaireResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  error?: QuestionnaireError;
  delivery?: 'voice';
  awaitingResponse?: boolean;
  voicePrompt?: string;
}

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  details: QuestionnaireResult;
  terminate?: boolean;
}
