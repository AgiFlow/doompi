import {
  controlPhraseTokens,
  controlPhraseTokenValues,
  LENIENT_CONTROL_PHRASE_EDIT_RATIO,
  matchesControlPhrase,
  matchLeadingControlPhrase,
  matchTrailingControlPhrase,
  STRICT_CONTROL_PHRASE_EDIT_RATIO,
} from './controlPhraseMatcher.ts';
import { alignNarrationSpan, extractNovelNarrationResidual } from './semanticEcho.ts';

/**
 * The phrases that shipped before composition became configurable.
 *
 * Still the resolved defaults in `doompi-config`, repeated here so a caller that supplies
 * no phrase set at all keeps working rather than silently losing composition.
 */
export const VOICE_COMPOSITION_START_PHRASE = 'hey doom';
export const VOICE_COMPOSITION_SEND_PHRASE = "that's it";
export const VOICE_COMPOSITION_CANCEL_PHRASE = 'doom cancel';

export const DEFAULT_VOICE_COMPOSITION_PHRASES: VoiceCompositionPhrases = {
  open: [VOICE_COMPOSITION_START_PHRASE, 'doom prompt'],
  send: [VOICE_COMPOSITION_SEND_PHRASE, 'doom send'],
  cancel: [VOICE_COMPOSITION_CANCEL_PHRASE, 'scratch that'],
};

export interface VoiceCompositionPhrases {
  open: readonly string[];
  send: readonly string[];
  cancel: readonly string[];
}

export type VoiceCompositionState = 'inactive' | 'collecting' | 'submitting';

export type TranscriptPolicyResult =
  | { action: 'deliver'; text: string }
  | { action: 'compose-open'; text: string }
  | { action: 'compose-append'; text: string }
  /** `text` carries content spoken ahead of a trailing send command, if any. */
  | { action: 'compose-send'; text?: string }
  | { action: 'compose-cancel' }
  | { action: 'discard'; reason: 'empty' | 'narration-echo' }
  | { action: 'stop' };

export interface TranscriptPolicyInput {
  transcript: string;
  narrationOverlapPromoted?: boolean;
  startPhrases: readonly string[];
  stopPhrases: readonly string[];
  compositionPhrases?: VoiceCompositionPhrases;
  narrationReferences?: readonly string[];
  compositionState?: VoiceCompositionState;
}

const MAX_MISALIGNED_NARRATION_TAIL_TOKENS = 4;
/**
 * What must sit between the last content word and a trailing command.
 *
 * A transcriber writes a sentence break where the speaker made one, so this is the
 * cheapest available evidence that "that's it" closed a thought rather than continuing
 * one. Without it, "I want it to be exactly that's it" would submit.
 */
const SENTENCE_BOUNDARY_PATTERN = /[.,;:!?…]["'”’)\]]*\s*$/u;
/** Punctuation left behind once a leading control phrase is removed. */
const LEADING_PUNCTUATION_PATTERN = /^[\s\p{P}\p{S}]+/u;

/** What is left of an utterance once a leading phrase and its punctuation are removed. */
function remainderAfter(value: string, end: number): string {
  return value.slice(end).replace(LEADING_PUNCTUATION_PATTERN, '').trim();
}

function phraseTokenLists(phrases: readonly string[]): string[][] {
  return phrases.map((phrase) => controlPhraseTokenValues(phrase)).filter((tokens) => tokens.length > 0);
}

function exactPhrase(value: string, phrase: string): boolean {
  const valueTokens = controlPhraseTokenValues(value);
  const phraseTokens = controlPhraseTokenValues(phrase);
  return (
    valueTokens.length > 0 &&
    valueTokens.length === phraseTokens.length &&
    valueTokens.every((v, i) => v === phraseTokens[i])
  );
}

function stripAddressPhrase(
  value: string,
  phrases: readonly string[],
  maximumLeadingTokens: number,
): string | undefined {
  const tokens = controlPhraseTokens(value);
  for (const phrase of phrases) {
    const phraseTokens = controlPhraseTokenValues(phrase);
    if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) continue;
    const finalOffset = Math.min(maximumLeadingTokens, tokens.length - phraseTokens.length);
    for (let offset = 0; offset <= finalOffset; offset += 1) {
      const window = tokens.slice(offset, offset + phraseTokens.length).map((token) => token.value);
      if (!matchesControlPhrase(window, phraseTokens, STRICT_CONTROL_PHRASE_EDIT_RATIO)) continue;
      const finalToken = tokens[offset + phraseTokens.length - 1];
      if (!finalToken) continue;
      return remainderAfter(value, finalToken.end);
    }
  }
  return undefined;
}

function stripLeadingPhrase(value: string, phrases: readonly string[]): string {
  return stripAddressPhrase(value, phrases, 0) ?? value.trim();
}

/**
 * Whether a finalized segment is a command, and what content came with it.
 *
 * Two shapes count, and nothing else:
 *
 * 1. The segment is *nothing but* the phrase. Trimming an utterance down to two words
 *    while a draft is open is a deliberate act, so this earns the looser ratio.
 * 2. The phrase closes a longer sentence and the words before it end on sentence
 *    punctuation. A transcriber writes a break where the speaker made one, so that mark
 *    is the evidence that "that's it" finished a thought rather than continued one. It
 *    is what separates "just log the error, that's it" from "I want it to be exactly
 *    that's it", and it runs at the strict ratio because an embedded phrase has proved
 *    much less than a truncated one.
 *
 * Anything else is content. A missed command costs the user one repetition; a false one
 * submits a half-finished prompt, which is the thing composition exists to prevent.
 */
function commandMatch(value: string, phrases: readonly (readonly string[])[]): { carrier: string } | undefined {
  const tokens = controlPhraseTokens(value);
  if (tokens.length === 0) return undefined;
  const values = tokens.map((token) => token.value);
  for (const phrase of phrases) {
    if (matchesControlPhrase(values, phrase, LENIENT_CONTROL_PHRASE_EDIT_RATIO)) return { carrier: '' };
  }
  for (const phrase of phrases) {
    const start = matchTrailingControlPhrase(values, phrase, STRICT_CONTROL_PHRASE_EDIT_RATIO);
    if (start === undefined || start === 0) continue;
    const carrier = value.slice(0, tokens[start]!.start);
    if (!SENTENCE_BOUNDARY_PATTERN.test(carrier)) continue;
    return { carrier: carrier.trim() };
  }
  return undefined;
}

function compositionCommand(
  value: string,
  state: VoiceCompositionState,
  phrases: VoiceCompositionPhrases,
): TranscriptPolicyResult | undefined {
  const openPhrases = phraseTokenLists(phrases.open);
  if (state === 'inactive') {
    const tokens = controlPhraseTokenValues(value);
    for (const phrase of openPhrases) {
      const consumed = matchLeadingControlPhrase(tokens, phrase, STRICT_CONTROL_PHRASE_EDIT_RATIO);
      if (consumed === undefined) continue;
      const finalToken = controlPhraseTokens(value)[consumed - 1];
      return { action: 'compose-open', text: finalToken ? remainderAfter(value, finalToken.end) : '' };
    }
    return undefined;
  }
  if (state !== 'collecting') return undefined;
  const send = commandMatch(value, phraseTokenLists(phrases.send));
  if (send) return send.carrier ? { action: 'compose-send', text: send.carrier } : { action: 'compose-send' };
  // Cancel discards the draft, so its carrier is deliberately dropped rather than
  // appended: there is nothing left to append it to.
  if (commandMatch(value, phraseTokenLists(phrases.cancel))) return { action: 'compose-cancel' };
  return undefined;
}

function acceptedText(value: string, state: VoiceCompositionState): TranscriptPolicyResult {
  return state === 'collecting' ? { action: 'compose-append', text: value } : { action: 'deliver', text: value };
}

function narrationResidual(
  transcript: string,
  references: readonly string[],
): ReturnType<typeof extractNovelNarrationResidual> | undefined {
  let best: ReturnType<typeof extractNovelNarrationResidual> | undefined;
  for (const reference of references) {
    const analysis = extractNovelNarrationResidual(transcript, reference);
    if (!analysis.echoAligned) continue;
    if (!best || controlPhraseTokenValues(analysis.residual).length < controlPhraseTokenValues(best.residual).length)
      best = analysis;
  }
  return best;
}

export function applyTranscriptPolicy(input: TranscriptPolicyInput): TranscriptPolicyResult {
  const transcript = input.transcript.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!transcript) return { action: 'discard', reason: 'empty' };
  const references = input.narrationReferences ?? [];
  const compositionState = input.compositionState ?? 'inactive';
  const compositionPhrases = input.compositionPhrases ?? DEFAULT_VOICE_COMPOSITION_PHRASES;
  if (references.some((reference) => alignNarrationSpan(transcript, reference).aligned))
    return { action: 'discard', reason: 'narration-echo' };

  if (input.narrationOverlapPromoted) {
    const overlap = narrationResidual(transcript, references);
    const residual = overlap ? overlap.residualRuns.join(' ').trim() : transcript;
    if (!residual) return { action: 'discard', reason: 'narration-echo' };
    const addressedText = stripAddressPhrase(
      residual,
      input.startPhrases,
      overlap ? MAX_MISALIGNED_NARRATION_TAIL_TOKENS : 0,
    );
    const accepted = addressedText ?? residual;
    const composition =
      compositionCommand(residual, compositionState, compositionPhrases) ??
      (accepted === residual ? undefined : compositionCommand(accepted, compositionState, compositionPhrases));
    if (composition) return composition;
    if (input.stopPhrases.some((phrase) => exactPhrase(residual, phrase))) return { action: 'stop' };
    if (!accepted) return { action: 'discard', reason: 'empty' };
    if (input.stopPhrases.some((phrase) => exactPhrase(accepted, phrase))) return { action: 'stop' };
    return acceptedText(accepted, compositionState);
  }

  const composition = compositionCommand(transcript, compositionState, compositionPhrases);
  if (composition) return composition;
  if (input.stopPhrases.some((phrase) => exactPhrase(transcript, phrase))) return { action: 'stop' };
  const text = stripLeadingPhrase(transcript, input.startPhrases);
  if (!text) return { action: 'discard', reason: 'empty' };
  const addressedComposition = compositionCommand(text, compositionState, compositionPhrases);
  if (addressedComposition) return addressedComposition;
  return acceptedText(text, compositionState);
}
