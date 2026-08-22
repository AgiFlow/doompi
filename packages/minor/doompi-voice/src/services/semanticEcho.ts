import type { TtsPlaybackReference } from '../types/index.ts';
import type { AudioActivityHistogram } from './vad.ts';

const DEFAULT_ECHO_TAIL_MS = 800;
const MIN_ALIGNMENT_SIMILARITY = 0.75;

export type EchoProbeAction = 'continue' | 'interrupt' | 'ignore';
export type EchoProbeClassification =
  | 'classifier_error'
  | 'duplicate'
  | 'echo'
  | 'no_reference'
  | 'no_speech'
  | 'pressure'
  | 'residual_speech'
  | 'stale'
  | 'stop_phrase';

export interface EchoReference {
  generation: number;
  playback: TtsPlaybackReference;
  echoTailUntil?: number;
}

export interface EchoProbeInput {
  generation: number;
  revision: number;
  transcript: string;
  newUtterance: boolean;
  observedAt: number;
  reference?: EchoReference;
  activity: AudioActivityHistogram;
  stopPhrases: readonly string[];
}

export interface EchoProbeResult {
  generation: number;
  revision: number;
  action: EchoProbeAction;
  classification: EchoProbeClassification;
}

export interface ControlPhraseMatch {
  tokenIndex: number;
  tokenLength: number;
  phraseTokenLength: number;
}

export interface NarrationAlignment {
  aligned: boolean;
  similarity: number;
}

export interface NarrationResidualAnalysis {
  echoAligned: boolean;
  residualRuns: string[];
  /** Compatibility view for clean-lane consumers; never use it for playback stop matching. */
  residual: string;
}

export interface RollingEchoProbeState {
  generation?: number;
  activeRevision?: number;
  pendingRevision?: number;
  highestRevision: number;
}

export interface IEchoProbeClassifier {
  classify(input: EchoProbeInput, signal: AbortSignal): Promise<EchoProbeResult>;
}

interface QueuedProbe {
  input: EchoProbeInput;
  controller: AbortController;
  resolve: (result: EchoProbeResult) => void;
}

function resultFor(
  input: Pick<EchoProbeInput, 'generation' | 'revision'>,
  action: EchoProbeAction,
  classification: EchoProbeClassification,
): EchoProbeResult {
  return { generation: input.generation, revision: input.revision, action, classification };
}

function tokenize(value: string): string[] {
  const normalized = normalizeEchoText(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

function tokenDistance(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitution = previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1);
      current.push(Math.min(previous[rightIndex + 1] + 1, current[rightIndex] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

function controlPhraseDrift(tokenCount: number): number {
  if (tokenCount < 3) return 0;
  return Math.min(2, Math.floor(tokenCount / 3));
}

function findPhraseAt(
  transcriptTokens: readonly string[],
  phraseTokens: readonly string[],
  startIndex: number,
): ControlPhraseMatch | undefined {
  if (phraseTokens.length === 0 || startIndex >= transcriptTokens.length) return undefined;
  const allowedDrift = controlPhraseDrift(phraseTokens.length);
  const minimumLength = Math.max(1, phraseTokens.length - allowedDrift);
  const maximumLength = Math.min(transcriptTokens.length - startIndex, phraseTokens.length + allowedDrift);

  for (let candidateLength = minimumLength; candidateLength <= maximumLength; candidateLength += 1) {
    const candidate = transcriptTokens.slice(startIndex, startIndex + candidateLength);
    if (tokenDistance(phraseTokens, candidate) <= allowedDrift) {
      return { tokenIndex: startIndex, tokenLength: candidateLength, phraseTokenLength: phraseTokens.length };
    }
  }
  return undefined;
}

function referenceCoversObservation(reference: EchoReference, observedAt: number): boolean {
  if (observedAt < reference.playback.startedAt) return false;
  const audibleUntil = reference.echoTailUntil ?? reference.playback.endedAt;
  return audibleUntil === undefined || observedAt <= audibleUntil;
}

export function normalizeEchoText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function matchStartPhrase(
  transcript: string,
  phrases: readonly string[],
  newUtterance: boolean,
): ControlPhraseMatch | undefined {
  if (!newUtterance) return undefined;
  const transcriptTokens = tokenize(transcript);
  for (const phrase of phrases) {
    const match = findPhraseAt(transcriptTokens, tokenize(phrase), 0);
    if (match) return match;
  }
  return undefined;
}

export function matchStopPhrase(transcript: string, phrases: readonly string[]): ControlPhraseMatch | undefined {
  const transcriptTokens = tokenize(transcript);
  for (const phrase of phrases) {
    const phraseTokens = tokenize(phrase);
    for (let startIndex = 0; startIndex < transcriptTokens.length; startIndex += 1) {
      const match = findPhraseAt(transcriptTokens, phraseTokens, startIndex);
      if (match) return match;
    }
  }
  return undefined;
}

export function matchPlaybackStopPhrase(
  residualRun: string,
  phrases: readonly string[],
): ControlPhraseMatch | undefined {
  const transcriptTokens = tokenize(residualRun);
  for (const phrase of phrases) {
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length === 0 || phraseTokens.length > transcriptTokens.length) continue;
    for (let tokenIndex = 0; tokenIndex + phraseTokens.length <= transcriptTokens.length; tokenIndex += 1) {
      if (phraseTokens.every((token, offset) => transcriptTokens[tokenIndex + offset] === token)) {
        return {
          tokenIndex,
          tokenLength: phraseTokens.length,
          phraseTokenLength: phraseTokens.length,
        };
      }
    }
  }
  return undefined;
}

export function alignNarrationSpan(transcript: string, narration: string): NarrationAlignment {
  const transcriptTokens = tokenize(transcript);
  const narrationTokens = tokenize(narration);
  if (transcriptTokens.length === 0) return { aligned: true, similarity: 1 };
  if (narrationTokens.length === 0) return { aligned: false, similarity: 0 };

  const allowedLengthDrift = Math.min(2, Math.floor(transcriptTokens.length / 4));
  const minimumLength = Math.max(1, transcriptTokens.length - allowedLengthDrift);
  const maximumLength = Math.min(narrationTokens.length, transcriptTokens.length + allowedLengthDrift);
  let bestSimilarity = 0;

  for (let candidateLength = minimumLength; candidateLength <= maximumLength; candidateLength += 1) {
    for (let startIndex = 0; startIndex + candidateLength <= narrationTokens.length; startIndex += 1) {
      const candidate = narrationTokens.slice(startIndex, startIndex + candidateLength);
      const scale = Math.max(transcriptTokens.length, candidate.length);
      const similarity = 1 - tokenDistance(transcriptTokens, candidate) / scale;
      bestSimilarity = Math.max(bestSimilarity, similarity);
    }
  }

  return { aligned: bestSimilarity >= MIN_ALIGNMENT_SIMILARITY, similarity: bestSimilarity };
}

export function extractNovelNarrationResidual(transcript: string, narration: string): NarrationResidualAnalysis {
  const transcriptTokens = tokenize(transcript);
  const narrationTokens = tokenize(narration);
  if (transcriptTokens.length === 0) return { echoAligned: true, residualRuns: [], residual: '' };
  if (narrationTokens.length === 0) {
    const residual = transcriptTokens.join(' ');
    return { echoAligned: false, residualRuns: [residual], residual };
  }
  if (
    transcriptTokens.length <= narrationTokens.length &&
    alignNarrationSpan(transcriptTokens.join(' '), narrationTokens.join(' ')).aligned
  ) {
    return { echoAligned: true, residualRuns: [], residual: '' };
  }

  const echoed = Array.from({ length: transcriptTokens.length }, () => false);
  let alignedTokenCount = 0;
  for (let transcriptIndex = 0; transcriptIndex < transcriptTokens.length;) {
    let longest = 0;
    for (let narrationIndex = 0; narrationIndex < narrationTokens.length; narrationIndex += 1) {
      let length = 0;
      while (
        transcriptIndex + length < transcriptTokens.length &&
        narrationIndex + length < narrationTokens.length &&
        transcriptTokens[transcriptIndex + length] === narrationTokens[narrationIndex + length]
      ) {
        length += 1;
      }
      longest = Math.max(longest, length);
    }
    const confident = longest >= 2 || (transcriptTokens.length === 1 && longest === 1);
    if (!confident) {
      transcriptIndex += 1;
      continue;
    }
    for (let offset = 0; offset < longest; offset += 1) echoed[transcriptIndex + offset] = true;
    alignedTokenCount += longest;
    transcriptIndex += longest;
  }

  const residualRuns: string[] = [];
  for (let index = 0; index < transcriptTokens.length;) {
    while (index < transcriptTokens.length && echoed[index]) index += 1;
    const start = index;
    while (index < transcriptTokens.length && !echoed[index]) index += 1;
    if (index > start) residualRuns.push(transcriptTokens.slice(start, index).join(' '));
  }
  const residual = residualRuns.join(' ');
  return { echoAligned: alignedTokenCount > 0, residualRuns, residual };
}

export class EchoTailTimeline {
  private reference: EchoReference | undefined;

  constructor(private readonly echoTailMs = DEFAULT_ECHO_TAIL_MS) {}

  begin(generation: number, playback: TtsPlaybackReference): void {
    this.reference = { generation, playback: { ...playback, endedAt: undefined } };
  }

  finish(generation: number, playbackId: number, endedAt: number): boolean {
    if (this.reference?.generation !== generation || this.reference.playback.id !== playbackId) return false;
    const safeEndedAt = Math.max(endedAt, this.reference.playback.startedAt);
    this.reference = {
      generation,
      playback: { ...this.reference.playback, endedAt: safeEndedAt },
      echoTailUntil: safeEndedAt + this.echoTailMs,
    };
    return true;
  }

  current(observedAt: number): EchoReference | undefined {
    if (!this.reference) return undefined;
    if (!referenceCoversObservation(this.reference, observedAt)) {
      this.reference = undefined;
      return undefined;
    }
    return {
      ...this.reference,
      playback: { ...this.reference.playback },
    };
  }

  playbackOverlapMs(windowStartedAt: number, windowEndedAt: number): number {
    if (!this.reference || windowEndedAt <= windowStartedAt) return 0;
    const referenceEnd = this.reference.echoTailUntil ?? this.reference.playback.endedAt ?? windowEndedAt;
    return Math.max(
      0,
      Math.min(windowEndedAt, referenceEnd) - Math.max(windowStartedAt, this.reference.playback.startedAt),
    );
  }

  clear(generation: number): void {
    if (this.reference?.generation === generation) this.reference = undefined;
  }
}

export class SemanticEchoAdjudicator implements IEchoProbeClassifier {
  async classify(input: EchoProbeInput, signal: AbortSignal): Promise<EchoProbeResult> {
    if (signal.aborted) return resultFor(input, 'ignore', 'stale');
    if (normalizeEchoText(input.transcript).length === 0) return resultFor(input, 'continue', 'no_speech');
    if (
      !input.reference ||
      input.reference.generation !== input.generation ||
      !referenceCoversObservation(input.reference, input.observedAt)
    ) {
      return resultFor(input, 'continue', 'no_reference');
    }

    const analysis = extractNovelNarrationResidual(input.transcript, input.reference.playback.text);
    if (analysis.residualRuns.length === 0) return resultFor(input, 'continue', 'echo');
    if (analysis.residualRuns.some((run) => matchPlaybackStopPhrase(run, input.stopPhrases))) {
      return resultFor(input, 'interrupt', 'stop_phrase');
    }
    return resultFor(input, 'continue', 'residual_speech');
  }
}

export class RollingEchoProbeCoordinator {
  private generation: number | undefined;
  private highestRevision = 0;
  private latestActionableRevision = 0;
  private latestNormalizedTranscript = '';
  private active: QueuedProbe | undefined;
  private pending: QueuedProbe | undefined;

  constructor(private readonly classifier: IEchoProbeClassifier) {}

  beginGeneration(generation: number): void {
    if (this.generation === generation) return;
    this.cancelQueued();
    this.generation = generation;
    this.highestRevision = 0;
    this.latestActionableRevision = 0;
    this.latestNormalizedTranscript = '';
  }

  submit(input: EchoProbeInput): Promise<EchoProbeResult> {
    if (this.generation !== input.generation || input.revision <= this.highestRevision) {
      return Promise.resolve(resultFor(input, 'ignore', 'stale'));
    }
    this.highestRevision = input.revision;
    const normalizedTranscript = normalizeEchoText(input.transcript);
    if (normalizedTranscript === this.latestNormalizedTranscript) {
      return Promise.resolve(resultFor(input, 'ignore', 'duplicate'));
    }
    this.latestNormalizedTranscript = normalizedTranscript;
    this.latestActionableRevision = input.revision;

    return new Promise((resolve) => {
      const queued: QueuedProbe = { input, controller: new AbortController(), resolve };
      if (!this.active) {
        this.start(queued);
        return;
      }
      if (this.pending) this.pending.resolve(resultFor(this.pending.input, 'ignore', 'pressure'));
      this.pending = queued;
    });
  }

  stopGeneration(generation: number): void {
    if (this.generation !== generation) return;
    this.cancelQueued();
    this.generation = undefined;
  }

  state(): RollingEchoProbeState {
    return {
      generation: this.generation,
      activeRevision: this.active?.input.revision,
      pendingRevision: this.pending?.input.revision,
      highestRevision: this.highestRevision,
    };
  }

  private start(queued: QueuedProbe): void {
    this.active = queued;
    void this.run(queued);
  }

  private async run(queued: QueuedProbe): Promise<void> {
    let result: EchoProbeResult;
    try {
      result = await this.classifier.classify(queued.input, queued.controller.signal);
    } catch {
      result = resultFor(queued.input, 'continue', 'classifier_error');
    }
    if (this.active !== queued) return;
    this.active = undefined;
    if (
      this.generation !== queued.input.generation ||
      this.latestActionableRevision !== queued.input.revision ||
      queued.controller.signal.aborted
    ) {
      queued.resolve(resultFor(queued.input, 'ignore', 'stale'));
    } else {
      queued.resolve(result);
    }
    const next = this.pending;
    this.pending = undefined;
    if (next && this.generation === next.input.generation) this.start(next);
    else if (next) next.resolve(resultFor(next.input, 'ignore', 'stale'));
  }

  private cancelQueued(): void {
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.controller.abort();
      active.resolve(resultFor(active.input, 'ignore', 'stale'));
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve(resultFor(pending.input, 'ignore', 'stale'));
    }
  }
}
