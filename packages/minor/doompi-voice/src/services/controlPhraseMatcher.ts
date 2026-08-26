/**
 * Deciding whether a spoken segment was a control command or ordinary dictation.
 *
 * Exact token equality was the whole matcher until now, which meant `doom sent`,
 * `dune prompt` and `thats it` all failed: every one of them is what a transcriber
 * routinely returns for a phrase the user said correctly. Loosening the comparison alone
 * would trade those misses for false submissions, because `that's it` is also a phrase
 * people say inside real sentences.
 *
 * So tolerance is spent where it is cheap and withheld where it is not. What earns the
 * looser ratio is position: an utterance that is nothing but the phrase was truncated
 * deliberately, and a user does not trim a sentence to two words by accident. A phrase
 * merely embedded in a longer utterance has proved nothing, so it stays strict and the
 * caller has to supply separate evidence. Strictness is inversely proportional to how
 * often the matcher runs on audio that was never a command.
 *
 * There is a floor to what string comparison can do. `dune` for `doom` is three edits on
 * a four-letter word, and admitting it would also admit `dam` and `don`. Those belong to
 * audio keyword spotting, which decides on sound before a transcriber ever guesses at
 * spelling.
 *
 * `phoneticKey` and `editDistance` come from `commandCorrection.ts` rather than being
 * reimplemented: both modules are answering "is this the same short word heard
 * differently", and two copies would drift.
 */

import { editDistance, phoneticKey } from './commandCorrection.ts';

/**
 * For a leading prefix or a trailing suffix, where the matcher runs on every utterance.
 *
 * One substitution in a four-character token. Accepts `send`/`sent` and `boom`/`doom`.
 */
export const STRICT_CONTROL_PHRASE_EDIT_RATIO = 0.25;

/**
 * For a whole-segment command, where truncating the utterance already showed intent.
 *
 * Roughly one substitution in three characters, or three in nine: the observed size of
 * transcriber wobble on short function words. Accepts `sit`/`it` and
 * `cancel`/`cancelled`, neither of which survives the strict ratio.
 */
export const LENIENT_CONTROL_PHRASE_EDIT_RATIO = 0.34;

/**
 * The phonetic path only rescues single-character spelling divergence.
 *
 * It exists for pairs like `hay`/`hey`, which sound identical but sit just past the
 * strict ratio on a three-letter token. Allowing two would also admit `dam` and `don`
 * for `doom`: all three reduce to the same key, so the key alone stops discriminating
 * once the spelling is free to move that far. Words further apart than this are a job
 * for audio keyword spotting, not for string comparison.
 */
const MAX_PHONETIC_EDIT_DISTANCE = 1;

/**
 * Below this length no tolerance is allowed at all.
 *
 * At one or two characters every pair is within a single edit, so `it`/`at` and
 * `on`/`in` would match and the comparison would stop meaning anything.
 */
const EXACT_TOKEN_CHARS = 2;

const APOSTROPHES = /['’ʼ]/gu;
/**
 * Keeps a contraction as one token.
 *
 * `that's it` tokenized on letters alone is three tokens while a transcriber's `thats it`
 * is two, so the counts never line up and the phrase can never match itself.
 */
const CONTROL_TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;

export interface ControlPhraseToken {
  value: string;
  start: number;
  end: number;
}

/** Tokenizes for matching while keeping offsets into the original string. */
export function controlPhraseTokens(value: string): ControlPhraseToken[] {
  return [...value.matchAll(CONTROL_TOKEN_PATTERN)].map((match) => ({
    value: match[0].replace(APOSTROPHES, '').toLocaleLowerCase(),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

export function controlPhraseTokenValues(value: string): string[] {
  return controlPhraseTokens(value).map((token) => token.value);
}

export function controlPhraseTokensEquivalent(left: string, right: string, maxEditRatio: number): boolean {
  if (left === right) return true;
  const scale = Math.max(left.length, right.length);
  if (scale === 0 || scale <= EXACT_TOKEN_CHARS) return false;
  const distance = editDistance(left, right);
  if (distance / scale <= maxEditRatio) return true;
  const leftKey = phoneticKey(left);
  return leftKey !== '' && leftKey === phoneticKey(right) && distance <= MAX_PHONETIC_EDIT_DISTANCE;
}

/**
 * Equal token count is required, not just tolerated.
 *
 * It is what keeps `that's it exactly` out: an extra word is a different utterance, not a
 * mispronounced one, and allowing drift here would let the matcher consume trailing
 * content the user meant to keep.
 */
export function matchesControlPhrase(
  candidate: readonly string[],
  phrase: readonly string[],
  maxEditRatio: number,
): boolean {
  if (phrase.length === 0 || candidate.length !== phrase.length) return false;
  return candidate.every((token, index) => controlPhraseTokensEquivalent(token, phrase[index]!, maxEditRatio));
}

/** Tokens consumed by a phrase at the very front, or `undefined`. */
export function matchLeadingControlPhrase(
  tokens: readonly string[],
  phrase: readonly string[],
  maxEditRatio: number,
): number | undefined {
  if (phrase.length === 0 || tokens.length < phrase.length) return undefined;
  return matchesControlPhrase(tokens.slice(0, phrase.length), phrase, maxEditRatio) ? phrase.length : undefined;
}

/**
 * Index where a phrase begins at the very end, or `undefined`.
 *
 * The suffix is taken at exactly the phrase length. The caller decides what the tokens
 * before it have to look like; on their own, trailing words prove nothing.
 */
export function matchTrailingControlPhrase(
  tokens: readonly string[],
  phrase: readonly string[],
  maxEditRatio: number,
): number | undefined {
  if (phrase.length === 0 || tokens.length < phrase.length) return undefined;
  const start = tokens.length - phrase.length;
  return matchesControlPhrase(tokens.slice(start), phrase, maxEditRatio) ? start : undefined;
}
