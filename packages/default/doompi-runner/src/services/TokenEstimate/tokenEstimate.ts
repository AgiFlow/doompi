/**
 * Estimates BPE tokens without carrying a vocabulary.
 *
 * Bytes are a poor proxy for what a result costs: measured against
 * `gpt-tokenizer`, real text ranges from 1.4 characters per token for base64 to
 * 4.7 for English prose, a spread of more than three. Truncation runs on every
 * command and is synchronous, so loading a real tokenizer here would charge
 * every session for a table most of them never need.
 *
 * The shape below follows how BPE actually behaves: punctuation forces token
 * boundaries, natural words are cheap, and runs mixing letters with digits are
 * expensive. Calibrated against `gpt-tokenizer` over build logs, source, JSON,
 * stack traces, CJK, base64, hex, and UUIDs, the worst error is a factor of
 * 1.46 either way. It stays an estimate, so the byte ceiling remains the hard
 * bound behind it.
 */

/** Characters per token for a natural word. */
const WORD_CHARS_PER_TOKEN = 5;
/** Characters per token for a run mixing letters and digits, which tokenizes poorly. */
const MIXED_CHARS_PER_TOKEN = 2.1;
/** Characters per token for a run of punctuation or whitespace. */
const PUNCTUATION_CHARS_PER_TOKEN = 2;
/** Dense scripts such as CJK cost about one token per character. */
const DENSE_SCRIPT_START = 0x2fff;
const ASTRAL_TOKEN_COST = 2;
const ALPHANUMERIC_RUN = /([^\p{L}\p{N}]+)/u;
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;
const HAS_DIGIT = /\d/u;
const HAS_LETTER = /[A-Za-z]/u;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const run of text.split(ALPHANUMERIC_RUN)) {
    if (run.length === 0) continue;
    if (!HAS_ALPHANUMERIC.test(run)) {
      tokens += run.length / PUNCTUATION_CHARS_PER_TOKEN;
      continue;
    }

    let ascii = 0;
    let dense = 0;
    let astral = 0;
    for (const character of run) {
      const code = character.codePointAt(0) ?? 0;
      if (code > 0xffff) astral += 1;
      else if (code > DENSE_SCRIPT_START) dense += 1;
      else ascii += 1;
    }
    tokens += astral * ASTRAL_TOKEN_COST + dense;
    if (ascii > 0) {
      const mixed = HAS_DIGIT.test(run) && HAS_LETTER.test(run);
      tokens += Math.max(1, ascii / (mixed ? MIXED_CHARS_PER_TOKEN : WORD_CHARS_PER_TOKEN));
    }
  }
  return Math.ceil(tokens);
}
