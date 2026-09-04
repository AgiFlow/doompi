import { VOICE_MEDIA_SAMPLE_RATE } from '../types/clientMedia.ts';

const PCM_BYTES_PER_SAMPLE = 2;
const PCM_SCALE = 32_768;
const HISTORY_MS = 2_000;
const ANALYSIS_MS = 300;
const MAX_LAG_MS = 500;
const ECHO_TAIL_MS = 800;
const ENVELOPE_BUCKET_MS = 20;
const COARSE_SAMPLE_STEP = 4;
const COARSE_LAG_STEP = 16;
const ACTIVE_FLOOR_DBFS = -55;
const RESIDUAL_FLOOR_DBFS = -50;
const STRONG_WAVEFORM_CORRELATION = 0.65;
const STRONG_ENVELOPE_CORRELATION = 0.75;
const INDEPENDENT_WAVEFORM_CORRELATION = 0.25;
const INDEPENDENT_ENVELOPE_CORRELATION = 0.35;
const ECHO_RESIDUAL_POWER_RATIO = 0.35;
const MIXED_RESIDUAL_POWER_RATIO = 0.5;
const MAX_GAIN = 4;
const CLIPPING_THRESHOLD = 0.98;
const MAX_CLIPPED_SAMPLE_RATIO = 0.01;

const HISTORY_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * HISTORY_MS) / 1_000;
const ANALYSIS_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * ANALYSIS_MS) / 1_000;
const MAX_LAG_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * MAX_LAG_MS) / 1_000;
const ECHO_TAIL_SECONDS = ECHO_TAIL_MS / 1_000;
const ENVELOPE_BUCKET_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * ENVELOPE_BUCKET_MS) / 1_000;

interface PlaybackReference {
  readonly playbackId: string;
  samples: Float32Array;
  startedAt: number;
  endedAt?: number;
}

export type BrowserEchoDiscriminationState = 'unavailable' | 'echo' | 'mixed' | 'near-end' | 'uncertain';

export interface BrowserEchoDiscriminationResult {
  readonly speechPcm: Uint8Array;
  readonly referenceActive: boolean;
  readonly speechDiscriminated: boolean;
  readonly state: BrowserEchoDiscriminationState;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  if (pcm.byteLength === 0 || pcm.byteLength % PCM_BYTES_PER_SAMPLE !== 0)
    throw new Error('Echo-discrimination input must contain complete PCM16 samples.');
  const samples = new Float32Array(pcm.byteLength / PCM_BYTES_PER_SAMPLE);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / PCM_SCALE;
  return samples;
}

function floatToPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * PCM_BYTES_PER_SAMPLE);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index] ?? 0, -1, 1);
    view.setInt16(
      index * PCM_BYTES_PER_SAMPLE,
      sample < 0 ? Math.round(sample * PCM_SCALE) : Math.round(sample * 32_767),
      true,
    );
  }
  return pcm;
}

function appendBounded(
  history: Float32Array<ArrayBufferLike>,
  incoming: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBuffer> {
  const retained = Math.min(history.length, Math.max(0, HISTORY_SAMPLES - incoming.length));
  const result = new Float32Array(retained + incoming.length);
  if (retained > 0) result.set(history.subarray(history.length - retained));
  result.set(incoming, retained);
  return result;
}

function dbfsFromPower(power: number): number {
  return power <= 0 ? Number.NEGATIVE_INFINITY : 10 * Math.log10(power);
}

function samplePower(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (const sample of samples) squareSum += sample * sample;
  return squareSum / samples.length;
}

function clippedSampleRatio(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let clippedSamples = 0;
  for (const sample of samples) if (Math.abs(sample) >= CLIPPING_THRESHOLD) clippedSamples += 1;
  return clippedSamples / samples.length;
}

function normalizedCorrelation(
  microphone: Float32Array,
  reference: Float32Array,
  microphoneStart: number,
  referenceStart: number,
  length: number,
  step: number,
): number {
  let microphoneSum = 0;
  let referenceSum = 0;
  let count = 0;
  for (let offset = 0; offset < length; offset += step) {
    const microphoneSample = microphone[microphoneStart + offset];
    const referenceSample = reference[referenceStart + offset];
    if (microphoneSample === undefined || referenceSample === undefined) continue;
    microphoneSum += microphoneSample;
    referenceSum += referenceSample;
    count += 1;
  }
  if (count < 2) return 0;
  const microphoneMean = microphoneSum / count;
  const referenceMean = referenceSum / count;
  let dot = 0;
  let microphonePower = 0;
  let referencePower = 0;
  for (let offset = 0; offset < length; offset += step) {
    const microphoneSample = microphone[microphoneStart + offset];
    const referenceSample = reference[referenceStart + offset];
    if (microphoneSample === undefined || referenceSample === undefined) continue;
    const microphoneCentered = microphoneSample - microphoneMean;
    const referenceCentered = referenceSample - referenceMean;
    dot += microphoneCentered * referenceCentered;
    microphonePower += microphoneCentered * microphoneCentered;
    referencePower += referenceCentered * referenceCentered;
  }
  const denominator = Math.sqrt(microphonePower * referencePower);
  return denominator <= Number.EPSILON ? 0 : dot / denominator;
}

function envelopeCorrelation(
  microphone: Float32Array,
  reference: Float32Array,
  microphoneStart: number,
  referenceStart: number,
  length: number,
): number {
  const microphoneEnvelope: number[] = [];
  const referenceEnvelope: number[] = [];
  for (let offset = 0; offset + ENVELOPE_BUCKET_SAMPLES <= length; offset += ENVELOPE_BUCKET_SAMPLES) {
    let microphonePower = 0;
    let referencePower = 0;
    for (let sample = 0; sample < ENVELOPE_BUCKET_SAMPLES; sample += 1) {
      const microphoneValue = microphone[microphoneStart + offset + sample] ?? 0;
      const referenceValue = reference[referenceStart + offset + sample] ?? 0;
      microphonePower += microphoneValue * microphoneValue;
      referencePower += referenceValue * referenceValue;
    }
    microphoneEnvelope.push(Math.log10(Math.max(Number.EPSILON, microphonePower / ENVELOPE_BUCKET_SAMPLES)));
    referenceEnvelope.push(Math.log10(Math.max(Number.EPSILON, referencePower / ENVELOPE_BUCKET_SAMPLES)));
  }
  if (microphoneEnvelope.length < 3) return 0;
  return normalizedCorrelation(
    Float32Array.from(microphoneEnvelope),
    Float32Array.from(referenceEnvelope),
    0,
    0,
    microphoneEnvelope.length,
    1,
  );
}

function silenceLike(pcm: Uint8Array): Uint8Array {
  return new Uint8Array(pcm.byteLength);
}

/** Conservative exact-reference discriminator. Uncertain overlap is intentionally classified as silence. */
export class BrowserNarrationEchoDiscriminator {
  private references: PlaybackReference[] = [];
  private microphoneHistory = new Float32Array(0);
  private referenceHistory = new Float32Array(0);

  public beginPlayback(playbackId: string, samples: Float32Array, startedAt: number): void {
    if (!playbackId || samples.length === 0 || !Number.isFinite(startedAt)) return;
    for (const reference of this.references) {
      if (reference.endedAt === undefined) this.finishReference(reference, startedAt);
    }
    this.references.push({ playbackId, samples, startedAt });
  }

  public endPlayback(playbackId: string, endedAt: number): void {
    if (!Number.isFinite(endedAt)) return;
    const reference = this.references.findLast((candidate) => candidate.playbackId === playbackId);
    if (reference !== undefined && reference.endedAt === undefined) this.finishReference(reference, endedAt);
  }

  public process(pcm: Uint8Array, capturedAt: number): BrowserEchoDiscriminationResult {
    const microphone = pcm16ToFloat(pcm);
    if (!Number.isFinite(capturedAt)) return this.unavailable(pcm, microphone);
    const durationSeconds = microphone.length / VOICE_MEDIA_SAMPLE_RATE;
    const captureStart = capturedAt - durationSeconds;
    this.pruneReferences(captureStart);
    const rendered = this.renderReference(captureStart, microphone.length);
    this.microphoneHistory = appendBounded(this.microphoneHistory, microphone);
    this.referenceHistory = appendBounded(this.referenceHistory, rendered.samples);
    if (!rendered.tracked)
      return {
        speechPcm: new Uint8Array(pcm),
        referenceActive: false,
        speechDiscriminated: false,
        state: 'unavailable',
      };

    const analysisLength = Math.min(ANALYSIS_SAMPLES, this.microphoneHistory.length);
    const microphoneStart = this.microphoneHistory.length - analysisLength;
    const alignedReferenceStart = this.referenceHistory.length - analysisLength;
    const availableLag = Math.min(MAX_LAG_SAMPLES, alignedReferenceStart);
    const referenceRegionStart = Math.max(0, alignedReferenceStart - availableLag);
    const referenceRegion = this.referenceHistory.subarray(referenceRegionStart);
    const microphoneRegion = this.microphoneHistory.subarray(microphoneStart);
    const microphoneDbfs = dbfsFromPower(samplePower(microphoneRegion));
    const referenceDbfs = dbfsFromPower(samplePower(referenceRegion));

    if (referenceDbfs < ACTIVE_FLOOR_DBFS) {
      if (microphoneDbfs >= RESIDUAL_FLOOR_DBFS)
        return { speechPcm: new Uint8Array(pcm), referenceActive: true, speechDiscriminated: true, state: 'near-end' };
      return { speechPcm: silenceLike(pcm), referenceActive: true, speechDiscriminated: false, state: 'echo' };
    }
    if (analysisLength < ANALYSIS_SAMPLES || availableLag <= 0)
      return { speechPcm: silenceLike(pcm), referenceActive: true, speechDiscriminated: false, state: 'uncertain' };
    if (clippedSampleRatio(microphoneRegion) > MAX_CLIPPED_SAMPLE_RATIO)
      return { speechPcm: silenceLike(pcm), referenceActive: true, speechDiscriminated: false, state: 'uncertain' };

    let bestLag = 0;
    let bestCorrelation = 0;
    for (let lag = 0; lag <= availableLag; lag += COARSE_LAG_STEP) {
      const correlation = normalizedCorrelation(
        this.microphoneHistory,
        this.referenceHistory,
        microphoneStart,
        alignedReferenceStart - lag,
        analysisLength,
        COARSE_SAMPLE_STEP,
      );
      if (Math.abs(correlation) > Math.abs(bestCorrelation)) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }
    const refinementStart = Math.max(0, bestLag - COARSE_LAG_STEP);
    const refinementEnd = Math.min(availableLag, bestLag + COARSE_LAG_STEP);
    for (let lag = refinementStart; lag <= refinementEnd; lag += 1) {
      const correlation = normalizedCorrelation(
        this.microphoneHistory,
        this.referenceHistory,
        microphoneStart,
        alignedReferenceStart - lag,
        analysisLength,
        2,
      );
      if (Math.abs(correlation) > Math.abs(bestCorrelation)) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }

    const referenceStart = alignedReferenceStart - bestLag;
    const envelope = Math.abs(
      envelopeCorrelation(
        this.microphoneHistory,
        this.referenceHistory,
        microphoneStart,
        referenceStart,
        analysisLength,
      ),
    );
    const waveform = Math.abs(bestCorrelation);
    let dot = 0;
    let referencePowerSum = 0;
    let microphonePowerSum = 0;
    for (let offset = 0; offset < analysisLength; offset += 1) {
      const microphoneSample = this.microphoneHistory[microphoneStart + offset] ?? 0;
      const referenceSample = this.referenceHistory[referenceStart + offset] ?? 0;
      dot += microphoneSample * referenceSample;
      referencePowerSum += referenceSample * referenceSample;
      microphonePowerSum += microphoneSample * microphoneSample;
    }
    const gain = clamp(referencePowerSum <= Number.EPSILON ? 0 : dot / referencePowerSum, 0, MAX_GAIN);
    let residualPowerSum = 0;
    for (let offset = 0; offset < analysisLength; offset += 1) {
      const residual =
        (this.microphoneHistory[microphoneStart + offset] ?? 0) -
        gain * (this.referenceHistory[referenceStart + offset] ?? 0);
      residualPowerSum += residual * residual;
    }
    const residualPowerRatio = microphonePowerSum <= Number.EPSILON ? 0 : residualPowerSum / microphonePowerSum;
    const residual = new Float32Array(microphone.length);
    const currentMicrophoneStart = this.microphoneHistory.length - microphone.length;
    const currentReferenceStart = this.referenceHistory.length - microphone.length - bestLag;
    for (let index = 0; index < microphone.length; index += 1)
      residual[index] =
        (this.microphoneHistory[currentMicrophoneStart + index] ?? 0) -
        gain * (this.referenceHistory[currentReferenceStart + index] ?? 0);
    const residualPcm = floatToPcm16(residual);
    const residualDbfs = dbfsFromPower(samplePower(residual));

    if (bestCorrelation >= STRONG_WAVEFORM_CORRELATION && residualPowerRatio <= ECHO_RESIDUAL_POWER_RATIO)
      return { speechPcm: silenceLike(pcm), referenceActive: true, speechDiscriminated: false, state: 'echo' };
    if (
      bestCorrelation >= STRONG_WAVEFORM_CORRELATION &&
      envelope < STRONG_ENVELOPE_CORRELATION &&
      residualPowerRatio >= MIXED_RESIDUAL_POWER_RATIO &&
      residualDbfs >= RESIDUAL_FLOOR_DBFS
    )
      return { speechPcm: residualPcm, referenceActive: true, speechDiscriminated: true, state: 'mixed' };
    if (
      waveform < INDEPENDENT_WAVEFORM_CORRELATION &&
      envelope < INDEPENDENT_ENVELOPE_CORRELATION &&
      microphoneDbfs >= RESIDUAL_FLOOR_DBFS
    )
      return { speechPcm: new Uint8Array(pcm), referenceActive: true, speechDiscriminated: true, state: 'near-end' };
    if (envelope >= STRONG_ENVELOPE_CORRELATION)
      return { speechPcm: silenceLike(pcm), referenceActive: true, speechDiscriminated: false, state: 'echo' };
    return { speechPcm: silenceLike(pcm), referenceActive: true, speechDiscriminated: false, state: 'uncertain' };
  }

  public resetCapture(): void {
    this.microphoneHistory = new Float32Array(0);
    this.referenceHistory = new Float32Array(0);
  }

  public reset(): void {
    this.references = [];
    this.resetCapture();
  }

  private unavailable(pcm: Uint8Array, microphone = pcm16ToFloat(pcm)): BrowserEchoDiscriminationResult {
    this.microphoneHistory = appendBounded(this.microphoneHistory, microphone);
    this.referenceHistory = appendBounded(this.referenceHistory, new Float32Array(microphone.length));
    return { speechPcm: new Uint8Array(pcm), referenceActive: false, speechDiscriminated: false, state: 'unavailable' };
  }

  private renderReference(captureStart: number, sampleCount: number): { samples: Float32Array; tracked: boolean } {
    const samples = new Float32Array(sampleCount);
    let tracked = false;
    for (const reference of this.references) {
      const naturalEnd = reference.startedAt + reference.samples.length / VOICE_MEDIA_SAMPLE_RATE;
      const audibleEnd = Math.min(reference.endedAt ?? naturalEnd, naturalEnd);
      if (
        captureStart < audibleEnd + ECHO_TAIL_SECONDS &&
        captureStart + sampleCount / VOICE_MEDIA_SAMPLE_RATE >= reference.startedAt
      )
        tracked = true;
      const firstReferenceIndex = Math.round((captureStart - reference.startedAt) * VOICE_MEDIA_SAMPLE_RATE);
      const audibleSamples = Math.round((audibleEnd - reference.startedAt) * VOICE_MEDIA_SAMPLE_RATE);
      for (let index = 0; index < sampleCount; index += 1) {
        const referenceIndex = firstReferenceIndex + index;
        if (referenceIndex < 0 || referenceIndex >= audibleSamples) continue;
        samples[index] += reference.samples[referenceIndex] ?? 0;
      }
    }
    return { samples, tracked };
  }

  private finishReference(reference: PlaybackReference, endedAt: number): void {
    const naturalEnd = reference.startedAt + reference.samples.length / VOICE_MEDIA_SAMPLE_RATE;
    reference.endedAt = Math.max(reference.startedAt, Math.min(endedAt, naturalEnd));
    const endedSample = Math.ceil((reference.endedAt - reference.startedAt) * VOICE_MEDIA_SAMPLE_RATE);
    const retainedStart = Math.max(0, endedSample - MAX_LAG_SAMPLES - ANALYSIS_SAMPLES);
    reference.samples = new Float32Array(reference.samples.subarray(retainedStart, endedSample));
    reference.startedAt += retainedStart / VOICE_MEDIA_SAMPLE_RATE;
  }

  private pruneReferences(at: number): void {
    this.references = this.references.filter((reference) => {
      if (reference.endedAt === undefined) return true;
      return at <= reference.endedAt + ECHO_TAIL_SECONDS;
    });
  }
}
