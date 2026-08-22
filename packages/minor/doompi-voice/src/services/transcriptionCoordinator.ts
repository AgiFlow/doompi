const PCM_LIMIT = 32_767;
const DEFAULT_TARGET_PEAK = 0.82;
const DEFAULT_MAX_GAIN = 8;

export interface PcmSignalSummary {
  sampleCount: number;
  nonZeroSamples: number;
  peak: number;
}

export function summarizePcm16(pcm: Buffer): PcmSignalSummary {
  if (pcm.length % 2 !== 0) throw new Error('PCM signal must contain complete 16-bit samples.');
  let nonZeroSamples = 0;
  let peak = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if (sample !== 0) nonZeroSamples += 1;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { sampleCount: pcm.length / 2, nonZeroSamples, peak };
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
