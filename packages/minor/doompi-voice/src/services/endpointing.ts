import { matchStartPhrase } from './semanticEcho.ts';

interface SourceToken {
  end: number;
}

function sourceTokens(value: string): SourceToken[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ end: (match.index ?? 0) + match[0].length }));
}

export function stripLeadingControlPhrase(transcript: string, phrases: readonly string[], newUtterance = true): string {
  const match = matchStartPhrase(transcript, phrases, newUtterance);
  if (!match) return transcript.trim();
  const tokens = sourceTokens(transcript);
  const finalToken = tokens[match.tokenLength - 1];
  if (!finalToken) return transcript.trim();
  return transcript
    .slice(finalToken.end)
    .replace(/^[\s\p{P}\p{S}]+/u, '')
    .trim();
}
