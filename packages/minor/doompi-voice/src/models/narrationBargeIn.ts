const MINIMUM_BARGE_IN_SCORE = 80;
interface WeightedGuard {
  matched: boolean;
  weight: number;
}

export interface NarrationBargeInEvidence {
  exactStopCommand: boolean;
  intentionalAddress?: boolean;
  classifierConfirmed?: boolean;
  classifierSpeechMs?: number;
  residualTokenCount: number;
  residualRatio: number;
  voicedMs: number;
  peakDbAboveNoise: number;
  signalVariationDb: number;
  narrationSimilarity: number;
}

export function rankNarrationBargeInEvidence(evidence: NarrationBargeInEvidence): number {
  if (evidence.exactStopCommand) return 100;
  const classifierSpeechMs = evidence.classifierSpeechMs ?? 0;
  const guards: readonly WeightedGuard[] = [
    { matched: evidence.intentionalAddress === true, weight: 30 },
    { matched: evidence.classifierConfirmed === true || classifierSpeechMs >= 120, weight: 35 },
    { matched: classifierSpeechMs >= 300, weight: 15 },
    { matched: evidence.residualTokenCount >= 1, weight: 30 },
    { matched: evidence.residualTokenCount >= 2, weight: 20 },
    { matched: evidence.residualTokenCount >= 4, weight: 10 },
    { matched: evidence.residualRatio >= 0.3, weight: 15 },
    { matched: evidence.voicedMs >= 300, weight: 10 },
    { matched: evidence.peakDbAboveNoise >= 6, weight: 10 },
    { matched: evidence.signalVariationDb >= 3, weight: 10 },
    { matched: evidence.residualTokenCount > 0 && evidence.narrationSimilarity >= 0.75, weight: -50 },
  ];
  return guards.reduce((score, guard) => score + (guard.matched ? guard.weight : 0), 0);
}

export function narrationBargeInIsActionable(evidence: NarrationBargeInEvidence): boolean {
  const score = rankNarrationBargeInEvidence(evidence);
  const intentionalAddress =
    evidence.intentionalAddress === true && evidence.residualTokenCount >= 1 && score >= MINIMUM_BARGE_IN_SCORE;
  const trustedNaturalSpeech =
    evidence.classifierConfirmed === true &&
    (evidence.classifierSpeechMs ?? 0) >= 300 &&
    evidence.residualTokenCount >= 3 &&
    evidence.residualRatio >= 0.3 &&
    evidence.narrationSimilarity < 0.6 &&
    score >= MINIMUM_BARGE_IN_SCORE;
  return evidence.exactStopCommand || intentionalAddress || trustedNaturalSpeech;
}
