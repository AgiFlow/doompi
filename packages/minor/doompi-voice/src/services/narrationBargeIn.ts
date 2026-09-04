import { PCM_FRAME_BYTES, PCM_FRAME_MS } from './pcm.ts';
import { alignNarrationSpan, extractNovelNarrationResidual, normalizeEchoText } from './semanticEcho.ts';
import { AdaptiveVoiceActivityDetector, type AudioActivityHistogram, type VadNoiseProfile } from './vad.ts';

const OVERLAP_RING_FRAMES = 2_000 / PCM_FRAME_MS;
const PROBE_FRAMES = 1_200 / PCM_FRAME_MS;
const PROBE_INTERVAL_MS = 500;
const MINIMUM_BARGE_IN_SCORE = 80;
const MAX_MISALIGNED_NARRATION_TAIL_TOKENS = 4;

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

export type NarrationBargeInSpeechSource = 'narration' | 'user' | 'ambiguous';

export interface NarrationBargeInDecision {
  actionable: boolean;
  score: number;
  speechSource: NarrationBargeInSpeechSource;
  evidence: NarrationBargeInEvidence;
}

export interface NarrationBargeInReference {
  generation: number;
  text: string;
  startPhrases: readonly string[];
  stopPhrases: readonly string[];
}

export interface NarrationBargeInProbe {
  generation: number;
  revision: number;
  observedAt: number;
  pcm: Buffer;
  referenceText: string;
  startPhrases: readonly string[];
  stopPhrases: readonly string[];
  noiseProfile?: VadNoiseProfile;
  classifierSpeechMs?: number;
  classifierConfirmed?: boolean;
}

export interface NarrationBargeInMonitorDependencies {
  transcribe(probe: NarrationBargeInProbe, signal: AbortSignal): Promise<string>;
  onEvidence(generation: number, decision: NarrationBargeInDecision): void;
}

interface ActiveProbe {
  probe: NarrationBargeInProbe;
  controller: AbortController;
}

function tokenCount(value: string): number {
  const normalized = normalizeEchoText(value);
  return normalized ? normalized.split(' ').length : 0;
}

function overlapActivity(pcm: Buffer, noiseProfile?: VadNoiseProfile): AudioActivityHistogram {
  const vad = new AdaptiveVoiceActivityDetector(undefined, noiseProfile);
  let completed: AudioActivityHistogram | undefined;
  for (let offset = 0; offset + PCM_FRAME_BYTES <= pcm.length; offset += PCM_FRAME_BYTES) {
    const result = vad.push(pcm.subarray(offset, offset + PCM_FRAME_BYTES), { playbackOverlapMs: PCM_FRAME_MS });
    completed = result.segment?.activityHistogram ?? completed;
  }
  return (
    completed ??
    vad.flush()?.activityHistogram ?? {
      bucketMs: 100,
      buckets: [],
      durationMs: (pcm.length / PCM_FRAME_BYTES) * PCM_FRAME_MS,
      noiseFloorDbfs: noiseProfile?.averageDbfs ?? -60,
      speechThresholdDbfs: (noiseProfile?.averageDbfs ?? -60) + 10,
      voicedMs: 0,
      leadingSilenceMs: (pcm.length / PCM_FRAME_BYTES) * PCM_FRAME_MS,
      trailingSilenceMs: (pcm.length / PCM_FRAME_BYTES) * PCM_FRAME_MS,
      forcedClose: false,
    }
  );
}

function phraseTokens(phrase: string): string[] {
  return normalizeEchoText(phrase).split(' ').filter(Boolean);
}

function tokensMatchAt(tokens: readonly string[], phrase: readonly string[], offset: number): boolean {
  return phrase.length > 0 && phrase.every((token, index) => tokens[offset + index] === token);
}

function intentionalAddress(
  residualRuns: readonly string[],
  startPhrases: readonly string[],
  echoAligned: boolean,
): { detected: boolean; contentTokenCount: number } {
  const tokens = residualRuns.flatMap((run) => phraseTokens(run));
  const maximumOffset = echoAligned ? MAX_MISALIGNED_NARRATION_TAIL_TOKENS : 0;
  for (const phrase of startPhrases.map(phraseTokens)) {
    for (let offset = 0; offset <= Math.min(maximumOffset, tokens.length - phrase.length); offset += 1) {
      if (tokensMatchAt(tokens, phrase, offset))
        return { detected: true, contentTokenCount: tokens.length - offset - phrase.length };
    }
  }
  return { detected: false, contentTokenCount: tokens.length };
}

function exactResidualStopCommand(
  residualRuns: readonly string[],
  startPhrases: readonly string[],
  stopPhrases: readonly string[],
  echoAligned: boolean,
): boolean {
  const commands = stopPhrases.map(phraseTokens);
  const addresses = startPhrases.map(phraseTokens);
  return residualRuns.some((run) => {
    const tokens = phraseTokens(run);
    return commands.some((command) => {
      if (tokens.length < command.length) return false;
      const commandOffset = tokens.length - command.length;
      if (!tokensMatchAt(tokens, command, commandOffset)) return false;
      if (commandOffset === 0) return true;
      const commandPrefix = tokens.slice(0, commandOffset);
      if (
        addresses.some(
          (address) =>
            commandPrefix.length >= address.length &&
            tokensMatchAt(commandPrefix, address, commandPrefix.length - address.length) &&
            (commandPrefix.length === address.length ||
              (echoAligned && commandPrefix.length - address.length <= MAX_MISALIGNED_NARRATION_TAIL_TOKENS)),
        )
      )
        return true;
      return echoAligned && commandOffset <= MAX_MISALIGNED_NARRATION_TAIL_TOKENS;
    });
  });
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

export function classifyNarrationBargeInSource(evidence: NarrationBargeInEvidence): NarrationBargeInSpeechSource {
  if (evidence.exactStopCommand || evidence.intentionalAddress === true) return 'user';
  if (evidence.residualTokenCount === 0 || evidence.narrationSimilarity >= 0.6) return 'narration';
  const classifierConfirmed = evidence.classifierConfirmed === true || (evidence.classifierSpeechMs ?? 0) >= 120;
  if (classifierConfirmed && evidence.residualTokenCount >= 3 && evidence.residualRatio >= 0.3) return 'user';
  return 'ambiguous';
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

export function analyzeNarrationBargeIn(input: {
  transcript: string;
  referenceText: string;
  startPhrases: readonly string[];
  stopPhrases: readonly string[];
  pcm: Buffer;
  noiseProfile?: VadNoiseProfile;
  classifierSpeechMs?: number;
  classifierConfirmed?: boolean;
}): NarrationBargeInDecision {
  const activity = overlapActivity(input.pcm, input.noiseProfile);
  const analysis = extractNovelNarrationResidual(input.transcript, input.referenceText);
  const address = intentionalAddress(analysis.residualRuns, input.startPhrases, analysis.echoAligned);
  const residualTokenCount = address.contentTokenCount;
  const transcriptTokenCount = tokenCount(input.transcript);
  const levels = activity.buckets.map((bucket) => bucket.levelDbAboveNoise);
  const peakDbAboveNoise = levels.length > 0 ? Math.max(...levels) : 0;
  const signalVariationDb = levels.length > 1 ? Math.max(...levels) - Math.min(...levels) : 0;
  const classifierSpeechMs = Math.max(0, input.classifierSpeechMs ?? 0);
  const evidence: NarrationBargeInEvidence = {
    exactStopCommand: exactResidualStopCommand(
      analysis.residualRuns,
      input.startPhrases,
      input.stopPhrases,
      analysis.echoAligned,
    ),
    intentionalAddress: address.detected,
    classifierConfirmed: input.classifierConfirmed === true,
    classifierSpeechMs,
    residualTokenCount,
    residualRatio: transcriptTokenCount > 0 ? residualTokenCount / transcriptTokenCount : 0,
    voicedMs: activity.voicedMs,
    peakDbAboveNoise,
    signalVariationDb,
    narrationSimilarity: alignNarrationSpan(input.transcript, input.referenceText).similarity,
  };
  const score = rankNarrationBargeInEvidence(evidence);
  return {
    actionable: narrationBargeInIsActionable(evidence),
    score,
    speechSource: classifyNarrationBargeInSource(evidence),
    evidence,
  };
}

export class NarrationBargeInMonitor {
  private readonly frames: Buffer[] = [];
  private reference: NarrationBargeInReference | undefined;
  private activeProbe: ActiveProbe | undefined;
  private pendingProbe: NarrationBargeInProbe | undefined;
  private revision = 0;
  private nextProbeAt = 0;
  private awaitingAuthority = false;
  private promoted = false;
  private discarded = false;
  private classifierSpeechMs = 0;
  private classifierConfirmed = false;

  public constructor(private readonly dependencies: NarrationBargeInMonitorDependencies) {}

  public get confirmed(): boolean {
    return this.promoted;
  }

  public begin(reference: NarrationBargeInReference, observedAt: number): void {
    this.reset();
    this.reference = {
      ...reference,
      startPhrases: [...reference.startPhrases],
      stopPhrases: [...reference.stopPhrases],
    };
    this.nextProbeAt = observedAt;
  }

  public finish(generation: number): void {
    if (this.reference?.generation !== generation) return;
    this.cancelProbes();
    if (!this.promoted) this.reset();
  }

  public observe(
    frame: Buffer,
    observedAt: number,
    noiseProfile?: VadNoiseProfile,
    classifierSpeechMs = 0,
    classifierConfirmed = false,
  ): void {
    if (!this.reference || this.promoted || this.discarded) return;
    if (frame.length !== PCM_FRAME_BYTES)
      throw new Error(`Barge-in monitor requires ${PCM_FRAME_BYTES}-byte PCM frames`);
    this.classifierSpeechMs = Math.max(this.classifierSpeechMs, classifierSpeechMs);
    this.classifierConfirmed ||= classifierConfirmed;
    this.frames.push(Buffer.from(frame));
    while (this.frames.length > OVERLAP_RING_FRAMES) this.frames.shift();
    if (this.awaitingAuthority || observedAt < this.nextProbeAt || this.frames.length < PROBE_FRAMES) return;
    this.nextProbeAt = observedAt + PROBE_INTERVAL_MS;
    const probe: NarrationBargeInProbe = {
      generation: this.reference.generation,
      revision: ++this.revision,
      observedAt,
      pcm: Buffer.concat(this.frames.slice(-PROBE_FRAMES)),
      referenceText: this.reference.text,
      startPhrases: [...this.reference.startPhrases],
      stopPhrases: [...this.reference.stopPhrases],
      ...(noiseProfile ? { noiseProfile: { ...noiseProfile } } : {}),
      classifierSpeechMs: this.classifierSpeechMs,
      classifierConfirmed: this.classifierConfirmed,
    };
    this.schedule(probe);
  }

  public promote(generation: number): Buffer | undefined {
    if (this.reference?.generation !== generation || !this.awaitingAuthority || this.promoted) return undefined;
    this.promoted = true;
    this.awaitingAuthority = false;
    this.cancelProbes();
    const pcm = Buffer.concat(this.frames);
    this.frames.length = 0;
    return pcm;
  }

  public discard(generation: number): boolean {
    if (this.reference?.generation !== generation || !this.awaitingAuthority || this.promoted) return false;
    this.cancelProbes();
    this.frames.length = 0;
    this.awaitingAuthority = false;
    this.discarded = true;
    return true;
  }

  public reopenCleanLane(): void {
    if (!this.promoted) return;
    this.reset();
  }

  public stop(): void {
    this.reset();
  }

  private schedule(probe: NarrationBargeInProbe): void {
    if (this.activeProbe) {
      this.pendingProbe = probe;
      return;
    }
    const active = { probe, controller: new AbortController() };
    this.activeProbe = active;
    void this.run(active);
  }

  private async run(active: ActiveProbe): Promise<void> {
    const transcript = await this.dependencies
      .transcribe(active.probe, active.controller.signal)
      .catch(() => undefined);
    if (this.activeProbe !== active) return;
    this.activeProbe = undefined;
    if (
      transcript !== undefined &&
      !active.controller.signal.aborted &&
      this.reference?.generation === active.probe.generation
    ) {
      const decision = analyzeNarrationBargeIn({
        transcript,
        referenceText: active.probe.referenceText,
        startPhrases: active.probe.startPhrases,
        stopPhrases: active.probe.stopPhrases,
        pcm: active.probe.pcm,
        ...(active.probe.noiseProfile ? { noiseProfile: active.probe.noiseProfile } : {}),
        ...(active.probe.classifierSpeechMs === undefined
          ? {}
          : { classifierSpeechMs: active.probe.classifierSpeechMs }),
        ...(active.probe.classifierConfirmed === undefined
          ? {}
          : { classifierConfirmed: active.probe.classifierConfirmed }),
      });
      if (decision.actionable) {
        this.awaitingAuthority = true;
        this.pendingProbe = undefined;
        this.dependencies.onEvidence(active.probe.generation, decision);
        return;
      }
    }
    const pending = this.pendingProbe;
    this.pendingProbe = undefined;
    if (pending && this.reference?.generation === pending.generation) this.schedule(pending);
  }

  private cancelProbes(): void {
    this.activeProbe?.controller.abort();
    this.activeProbe = undefined;
    this.pendingProbe = undefined;
  }

  private reset(): void {
    this.cancelProbes();
    this.frames.length = 0;
    this.reference = undefined;
    this.revision = 0;
    this.nextProbeAt = 0;
    this.awaitingAuthority = false;
    this.promoted = false;
    this.discarded = false;
    this.classifierSpeechMs = 0;
    this.classifierConfirmed = false;
  }
}
