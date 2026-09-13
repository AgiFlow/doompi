const PCM_LIMIT = 32_767;
const PCM_SCALE = 32_768;
const DEFAULT_SAMPLE_RATE = 16_000;
const SIGNAL_FRAME_MS = 20;
const DEFAULT_TARGET_PEAK = 0.82;
const DEFAULT_MAX_GAIN = 8;

export interface PcmSignalSummary {
  sampleCount: number;
  nonZeroSamples: number;
  peak: number;
}

export interface PcmSignalEvidence extends PcmSignalSummary {
  durationMs: number;
  voicedMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  signalVariationDb: number;
  nonZeroRatio: number;
}

function dbfs(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -120;
}

export function analyzePcm16(pcm: Buffer, sampleRate = DEFAULT_SAMPLE_RATE): PcmSignalEvidence {
  if (pcm.length % 2 !== 0) throw new Error('PCM signal must contain complete 16-bit samples.');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('PCM sample rate must be positive.');
  const sampleCount = pcm.length / 2;
  const frameSamples = Math.max(1, Math.round((sampleRate * SIGNAL_FRAME_MS) / 1_000));
  let nonZeroSamples = 0;
  let peak = 0;
  let squareSum = 0;
  let frameSquareSum = 0;
  let frameSampleCount = 0;
  const frameLevels: number[] = [];
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    const normalized = sample / PCM_SCALE;
    if (sample !== 0) nonZeroSamples += 1;
    peak = Math.max(peak, Math.abs(sample));
    squareSum += normalized * normalized;
    frameSquareSum += normalized * normalized;
    frameSampleCount += 1;
    if (frameSampleCount === frameSamples || offset + 2 === pcm.length) {
      frameLevels.push(dbfs(Math.sqrt(frameSquareSum / frameSampleCount)));
      frameSquareSum = 0;
      frameSampleCount = 0;
    }
  }
  const sortedLevels = [...frameLevels].sort((left, right) => left - right);
  const noiseIndex = Math.max(0, Math.floor(sortedLevels.length * 0.2) - 1);
  const noiseFloor = sortedLevels[noiseIndex] ?? -120;
  const speechThreshold = Math.max(-58, Math.min(-40, noiseFloor + 8));
  const voicedFrames = frameLevels.filter((level) => level >= speechThreshold).length;
  const minimumLevel = frameLevels.length > 0 ? Math.min(...frameLevels) : -120;
  const maximumLevel = frameLevels.length > 0 ? Math.max(...frameLevels) : -120;
  return {
    sampleCount,
    nonZeroSamples,
    peak,
    durationMs: (sampleCount / sampleRate) * 1_000,
    voicedMs: Math.min((sampleCount / sampleRate) * 1_000, voicedFrames * SIGNAL_FRAME_MS),
    rmsDbfs: dbfs(sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0),
    peakDbfs: dbfs(peak / PCM_SCALE),
    signalVariationDb: maximumLevel - minimumLevel,
    nonZeroRatio: sampleCount > 0 ? nonZeroSamples / sampleCount : 0,
  };
}

export function summarizePcm16(pcm: Buffer): PcmSignalSummary {
  const evidence = analyzePcm16(pcm);
  return {
    sampleCount: evidence.sampleCount,
    nonZeroSamples: evidence.nonZeroSamples,
    peak: evidence.peak,
  };
}
export function normalizePcm16(pcm: Buffer, targetPeak = DEFAULT_TARGET_PEAK, maxGain = DEFAULT_MAX_GAIN): Buffer {
  if (!(targetPeak > 0 && targetPeak <= 1)) throw new Error('PCM normalization target peak must be in (0, 1].');
  if (!(maxGain >= 1 && Number.isFinite(maxGain))) throw new Error('PCM normalization maximum gain must be finite.');
  const summary = summarizePcm16(pcm);
  if (summary.peak === 0) return Buffer.from(pcm);
  const gain = Math.min(maxGain, (PCM_LIMIT * targetPeak) / summary.peak);
  if (gain <= 1) return Buffer.from(pcm);
  const normalized = Buffer.alloc(pcm.length);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const amplified = Math.round(pcm.readInt16LE(offset) * gain);
    normalized.writeInt16LE(Math.max(-PCM_LIMIT - 1, Math.min(PCM_LIMIT, amplified)), offset);
  }
  return normalized;
}
