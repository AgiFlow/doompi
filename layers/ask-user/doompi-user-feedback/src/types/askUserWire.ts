import type { QuestionAnswer } from './questionnaire.ts';

/**
 * How a rich client answers the whole questionnaire in one reply.
 *
 * Pi's select request carries a title and a list of labels and nothing else,
 * so over RPC the questionnaire degrades into one request per question, asked
 * forwards only. A client that can already see the whole call (the cockpit
 * reads it from the tool's arguments) has no use for that: it renders every
 * question at once, lets the reader move between them, and replies once.
 *
 * The reply rides on the select response, because that is the only channel a
 * blocked extension has. An ordinary label is still an ordinary label, so a
 * client that knows nothing about this keeps the per-question flow exactly as
 * it was; only a response carrying the prefix is read as the whole set.
 *
 * It lives under src/types because that is the one server root a browser
 * bundle may read, so neither half can drift from the other.
 */
export const ANSWER_ENVELOPE_PREFIX = 'doom-ask-user/v1:';

/** A response that claims the prefix but cannot be read is refused, never guessed at. */
export type AnswerEnvelopeRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'envelope'; readonly payload: unknown };

/** Beyond this a response is not a questionnaire answer, whatever it claims. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

export function encodeAnswerEnvelope(answers: readonly QuestionAnswer[]): string {
  return `${ANSWER_ENVELOPE_PREFIX}${JSON.stringify({ answers })}`;
}

export function decodeAnswerEnvelope(value: string | undefined): AnswerEnvelopeRead {
  if (value === undefined || !value.startsWith(ANSWER_ENVELOPE_PREFIX)) return { kind: 'absent' };
  if (value.length > MAX_ENVELOPE_BYTES) return { kind: 'malformed' };
  try {
    return { kind: 'envelope', payload: JSON.parse(value.slice(ANSWER_ENVELOPE_PREFIX.length)) };
  } catch {
    // Unreadable JSON behind the prefix: the sender meant an envelope and got
    // it wrong, which is a refusal rather than a label the model should see.
    return { kind: 'malformed' };
  }
}
