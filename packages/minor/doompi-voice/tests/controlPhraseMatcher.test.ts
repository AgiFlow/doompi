import { describe, expect, it } from 'vitest';
import {
  controlPhraseTokens,
  controlPhraseTokensEquivalent,
  controlPhraseTokenValues,
  LENIENT_CONTROL_PHRASE_EDIT_RATIO,
  matchesControlPhrase,
  matchLeadingControlPhrase,
  matchTrailingControlPhrase,
  STRICT_CONTROL_PHRASE_EDIT_RATIO,
} from '../src/services/controlPhraseMatcher.ts';

const strict = STRICT_CONTROL_PHRASE_EDIT_RATIO;
const lenient = LENIENT_CONTROL_PHRASE_EDIT_RATIO;

describe('control phrase tokenizer', () => {
  it('keeps a contraction as one token so a phrase can match itself', () => {
    // The whole reason the tokenizer changed: these two must agree on token count.
    expect(controlPhraseTokenValues("that's it")).toEqual(['thats', 'it']);
    expect(controlPhraseTokenValues('thats it')).toEqual(['thats', 'it']);
    expect(controlPhraseTokenValues('That’s it')).toEqual(['thats', 'it']);
  });

  it('drops surrounding punctuation and case', () => {
    expect(controlPhraseTokenValues('Hey, Doom!')).toEqual(['hey', 'doom']);
  });

  it('reports offsets past the whole token, contraction included', () => {
    // `stripAddressPhrase` slices from `end`, so a contraction must not leave a stray `t`.
    const tokens = controlPhraseTokens("don't stop");
    expect(tokens[0]).toMatchObject({ value: 'dont', start: 0, end: 5 });
    expect("don't stop".slice(tokens[0]!.end)).toBe(' stop');
  });

  it('does not swallow a trailing possessive apostrophe', () => {
    const tokens = controlPhraseTokens("dogs' bone");
    expect(tokens.map((token) => token.value)).toEqual(['dogs', 'bone']);
    expect(tokens[0]!.end).toBe(4);
  });
});

describe('control phrase token equivalence', () => {
  it.each([
    ['identical', 'thats', 'thats'],
    ['one substitution in four', 'send', 'sent'],
    ['phonetic with one edit', 'hay', 'hey'],
    ['one substitution in four', 'boom', 'doom'],
  ])('strict accepts %s', (_name, left, right) => {
    expect(controlPhraseTokensEquivalent(left, right, strict)).toBe(true);
  });

  it.each([
    ['a third of a short token', 'sit', 'it'],
    ['a suffix on a longer token', 'cancel', 'cancelled'],
  ])('strict rejects %s but lenient accepts it', (_name, left, right) => {
    expect(controlPhraseTokensEquivalent(left, right, strict)).toBe(false);
    expect(controlPhraseTokensEquivalent(left, right, lenient)).toBe(true);
  });

  it.each([
    ['three edits on a four-letter word', 'dune', 'doom'],
    ['a same-key word two edits away', 'dam', 'doom'],
    ['another same-key word two edits away', 'don', 'doom'],
  ])('rejects %s at both tolerances', (_name, left, right) => {
    // All three reduce to the same phonetic key, so the key alone stops discriminating.
    // Catching these is the job of audio keyword spotting, not string comparison.
    expect(controlPhraseTokensEquivalent(left, right, strict)).toBe(false);
    expect(controlPhraseTokensEquivalent(left, right, lenient)).toBe(false);
  });

  it('never fuzzes tokens at or below the exact-character floor', () => {
    // At two characters every pair is one edit apart, so any tolerance matches noise.
    expect(controlPhraseTokensEquivalent('it', 'at', lenient)).toBe(false);
    expect(controlPhraseTokensEquivalent('on', 'in', lenient)).toBe(false);
    expect(controlPhraseTokensEquivalent('it', 'it', lenient)).toBe(true);
  });

  it('rejects unrelated words at both tolerances', () => {
    expect(controlPhraseTokensEquivalent('exactly', 'it', lenient)).toBe(false);
    expect(controlPhraseTokensEquivalent('is', 'thats', lenient)).toBe(false);
  });
});

describe('whole-segment command matching', () => {
  const send = ['thats', 'it'];

  it.each(["that's it", 'thats it', 'that sit', 'That’s it.'])('accepts %s as a command', (utterance) => {
    expect(matchesControlPhrase(controlPhraseTokenValues(utterance), send, lenient)).toBe(true);
  });

  it('rejects an utterance with an extra word', () => {
    // An extra token is a different utterance, not a mispronounced one.
    expect(matchesControlPhrase(controlPhraseTokenValues("that's it exactly"), send, lenient)).toBe(false);
    expect(matchesControlPhrase(controlPhraseTokenValues("yeah that's it"), send, lenient)).toBe(false);
  });

  it('rejects a different short phrase of the same length', () => {
    expect(matchesControlPhrase(controlPhraseTokenValues('is that'), send, lenient)).toBe(false);
  });

  it('never matches an empty phrase', () => {
    expect(matchesControlPhrase([], [], lenient)).toBe(false);
    expect(matchesControlPhrase(['anything'], [], lenient)).toBe(false);
  });
});

describe('leading and trailing matching', () => {
  const open = ['hey', 'doom'];
  const send = ['thats', 'it'];

  it('consumes a leading phrase and reports its length', () => {
    expect(matchLeadingControlPhrase(controlPhraseTokenValues('hey doom refactor the parser'), open, strict)).toBe(2);
  });

  it('rejects a leading near-miss at strict tolerance', () => {
    // Opening a draft from the front of arbitrary dictation is the most expensive false
    // positive available, so the prefix stays strict.
    expect(matchLeadingControlPhrase(controlPhraseTokenValues('hey dune run the tests'), open, strict)).toBeUndefined();
  });

  it('rejects a phrase that is not at the front', () => {
    expect(matchLeadingControlPhrase(controlPhraseTokenValues('so hey doom'), open, strict)).toBeUndefined();
  });

  it('reports where a trailing phrase begins', () => {
    const tokens = controlPhraseTokenValues("and make it fast that's it");
    expect(matchTrailingControlPhrase(tokens, send, strict)).toBe(4);
  });

  it('refuses a trailing match when the tail is not the phrase', () => {
    expect(
      matchTrailingControlPhrase(controlPhraseTokenValues("yeah that's it exactly"), send, strict),
    ).toBeUndefined();
  });
});
