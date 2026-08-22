import { describe, expect, it } from 'vitest';
import { normalizePcm16, summarizePcm16 } from '../src/services/transcriptionCoordinator.ts';

describe('PCM transcription normalization', () => {
  it('summarizes and amplifies quiet signed samples without clipping', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(10, 0);
    pcm.writeInt16LE(-20, 2);
    pcm.writeInt16LE(0, 4);
    pcm.writeInt16LE(30_000, 6);

    expect(summarizePcm16(pcm)).toEqual({ sampleCount: 4, nonZeroSamples: 3, peak: 30_000 });
    expect(normalizePcm16(pcm)).toEqual(pcm);

    const quiet = Buffer.alloc(4);
    quiet.writeInt16LE(100, 0);
    quiet.writeInt16LE(-100, 2);
    const normalized = normalizePcm16(quiet);
    expect(normalized.readInt16LE(0)).toBe(800);
    expect(normalized.readInt16LE(2)).toBe(-800);
  });

  it('preserves digital silence and rejects invalid inputs', () => {
    const silence = Buffer.alloc(8);
    expect(normalizePcm16(silence)).toEqual(silence);
    expect(() => summarizePcm16(Buffer.alloc(3))).toThrow('complete 16-bit samples');
    expect(() => normalizePcm16(Buffer.alloc(2), 0)).toThrow('target peak');
    expect(() => normalizePcm16(Buffer.alloc(2), 1.1)).toThrow('target peak');
    expect(() => normalizePcm16(Buffer.alloc(2), 0.8, 0.5)).toThrow('maximum gain');
    expect(() => normalizePcm16(Buffer.alloc(2), 0.8, Number.POSITIVE_INFINITY)).toThrow('maximum gain');
  });
});
