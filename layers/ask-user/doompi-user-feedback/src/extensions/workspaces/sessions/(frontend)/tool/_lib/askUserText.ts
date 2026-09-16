/**
 * Pure text shaping for the ask_user_question card, apart from React so the
 * unit suite covers it without a DOM. Args and details are wire JSON; the
 * shapes narrowed here mirror src/types/questionnaire.ts, which this browser
 * module may not import at runtime.
 */

type Args = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface AskCallSummary {
  /** "N question(s)", the TUI heading's purpose. */
  count: string;
  /** The question headers, comma separated; empty when none carry one. */
  headers: string;
}

/** The call header: how many questions, and their headers in parentheses. */
export function askCallSummary(args: Args): AskCallSummary {
  const questions = Array.isArray(args.questions) ? args.questions.filter(isRecord) : [];
  const headers = questions.map((question) => asString(question.header)).filter(Boolean);
  return {
    count: `${questions.length} question${questions.length === 1 ? '' : 's'}`,
    headers: headers.join(', '),
  };
}

export interface AnsweredQuestion {
  question: string;
  answer: string;
}

export type AskResultView =
  | { kind: 'cancelled' }
  | { kind: 'voice'; prompt: string }
  | { kind: 'answers'; answers: AnsweredQuestion[] }
  | { kind: 'text'; text: string };

/**
 * The result body the TUI's renderResult chooses: a cancelled glyph, the
 * voice prompt when the questionnaire was handed to voice, the answered
 * list, or the raw text when the tool attached no details (an error path).
 */
export function askResultView(details: unknown, output: string): AskResultView {
  if (!isRecord(details) || !Array.isArray(details.answers)) return { kind: 'text', text: output };
  if (details.cancelled === true) return { kind: 'cancelled' };
  if (details.delivery === 'voice' && typeof details.voicePrompt === 'string') {
    return { kind: 'voice', prompt: details.voicePrompt };
  }
  const answers = details.answers.filter(isRecord).map((answer) => ({
    question: asString(answer.question),
    answer:
      answer.kind === 'multi'
        ? (Array.isArray(answer.selected) ? answer.selected : []).filter((v) => typeof v === 'string').join(', ')
        : asString(answer.answer),
  }));
  return { kind: 'answers', answers };
}
