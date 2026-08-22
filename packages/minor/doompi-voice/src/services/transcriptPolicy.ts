import { alignNarrationSpan, extractNovelNarrationResidual } from './semanticEcho.ts';

export type TranscriptPolicyResult =
  | { action: 'deliver'; text: string }
  | { action: 'discard'; reason: 'empty' | 'narration-echo' }
  | { action: 'stop' };

export interface TranscriptPolicyInput {
  transcript: string;
  narrationOverlapPromoted?: boolean;
  startPhrases: readonly string[];
  stopPhrases: readonly string[];
  narrationReferences?: readonly string[];
}

const MAX_MISALIGNED_NARRATION_TAIL_TOKENS = 4;

interface SourceToken {
  value: string;
  end: number;
}

function sourceTokens(value: string): SourceToken[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: match[0].toLocaleLowerCase(),
    end: (match.index ?? 0) + match[0].length,
  }));
}

function normalizedTokens(value: string): string[] {
  return sourceTokens(value).map((token) => token.value);
}

function exactPhrase(value: string, phrase: string): boolean {
  const valueTokens = normalizedTokens(value);
  const phraseTokens = normalizedTokens(phrase);
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
  const tokens = sourceTokens(value);
  for (const phrase of phrases) {
    const phraseTokens = normalizedTokens(phrase);
    if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) continue;
    const finalOffset = Math.min(maximumLeadingTokens, tokens.length - phraseTokens.length);
    for (let offset = 0; offset <= finalOffset; offset += 1) {
      if (!phraseTokens.every((token, index) => tokens[offset + index]?.value === token)) continue;
      const finalToken = tokens[offset + phraseTokens.length - 1];
      if (!finalToken) continue;
      return value
        .slice(finalToken.end)
        .replace(/^[\s\p{P}\p{S}]+/u, '')
        .trim();
    }
  }
  return undefined;
}

function stripLeadingPhrase(value: string, phrases: readonly string[]): string {
  return stripAddressPhrase(value, phrases, 0) ?? value.trim();
}

function narrationResidual(
  transcript: string,
  references: readonly string[],
): ReturnType<typeof extractNovelNarrationResidual> | undefined {
  let best: ReturnType<typeof extractNovelNarrationResidual> | undefined;
  for (const reference of references) {
    const analysis = extractNovelNarrationResidual(transcript, reference);
    if (!analysis.echoAligned) continue;
    if (!best || normalizedTokens(analysis.residual).length < normalizedTokens(best.residual).length) best = analysis;
  }
  return best;
}

export function applyTranscriptPolicy(input: TranscriptPolicyInput): TranscriptPolicyResult {
  const transcript = input.transcript.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!transcript) return { action: 'discard', reason: 'empty' };
  const references = input.narrationReferences ?? [];
  if (references.some((reference) => alignNarrationSpan(transcript, reference).aligned))
    return { action: 'discard', reason: 'narration-echo' };

  if (input.narrationOverlapPromoted) {
    const overlap = narrationResidual(transcript, references);
    const residual = overlap ? overlap.residualRuns.join(' ').trim() : transcript;
    if (!residual) return { action: 'discard', reason: 'narration-echo' };
    if (input.stopPhrases.some((phrase) => exactPhrase(residual, phrase))) return { action: 'stop' };
    const addressedText = stripAddressPhrase(
      residual,
      input.startPhrases,
      overlap ? MAX_MISALIGNED_NARRATION_TAIL_TOKENS : 0,
    );
    if (addressedText === undefined) return { action: 'discard', reason: 'narration-echo' };
    if (!addressedText) return { action: 'discard', reason: 'empty' };
    if (input.stopPhrases.some((phrase) => exactPhrase(addressedText, phrase))) return { action: 'stop' };
    return { action: 'deliver', text: addressedText };
  }

  if (input.stopPhrases.some((phrase) => exactPhrase(transcript, phrase))) return { action: 'stop' };
  const text = stripLeadingPhrase(transcript, input.startPhrases);
  if (!text) return { action: 'discard', reason: 'empty' };
  return { action: 'deliver', text };
}
