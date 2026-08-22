import { describe, expect, it, vi } from 'vitest';
import {
  analyzeNarrationBargeIn,
  NarrationBargeInMonitor,
  narrationBargeInIsActionable,
  rankNarrationBargeInEvidence,
} from '../src/services/narrationBargeIn.ts';
import { PCM_FRAME_BYTES } from '../src/services/pcm.ts';

function pcmFrame(sample: number): Buffer {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(sample, offset);
  return frame;
}

function speechWindow(): Buffer {
  return Buffer.concat(Array.from({ length: 60 }, (_, index) => pcmFrame(index % 3 === 0 ? 9_000 : 5_000)));
}

describe('ranked narration barge-in', () => {
  it('rejects narration-only echo even when playback energy is strong', () => {
    const decision = analyzeNarrationBargeIn({
      transcript: 'The plan is ready for review',
      referenceText: 'The plan is ready for review',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
      pcm: speechWindow(),
    });

    expect(decision.actionable).toBe(false);
    expect(decision.evidence.residualTokenCount).toBe(0);
  });

  it('rejects high-scoring narration residuals without intentional address', () => {
    const decision = analyzeNarrationBargeIn({
      transcript: 'The plan is ready please handle my new request',
      referenceText: 'The plan is ready',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
      pcm: speechWindow(),
    });

    expect(decision.evidence).toMatchObject({
      exactStopCommand: false,
      intentionalAddress: false,
      residualTokenCount: 5,
    });
    expect(decision.score).toBeGreaterThanOrEqual(80);
    expect(decision.actionable).toBe(false);
  });

  it('combines intentional address with semantic and acoustic guards for novel user speech', () => {
    const decision = analyzeNarrationBargeIn({
      transcript: 'The plan is ready hey doom please handle my new request',
      referenceText: 'The plan is ready',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
      pcm: speechWindow(),
    });

    expect(decision.evidence).toMatchObject({
      exactStopCommand: false,
      intentionalAddress: true,
      residualTokenCount: 5,
    });
    expect(decision.score).toBeGreaterThanOrEqual(80);
    expect(decision.actionable).toBe(true);
  });

  it('accepts only an exact command in the narration-removed residual', () => {
    const decision = analyzeNarrationBargeIn({
      transcript: 'The plan is ready stop speaking',
      referenceText: 'The plan is ready',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
      pcm: Buffer.alloc(60 * PCM_FRAME_BYTES),
    });

    expect(decision.evidence.exactStopCommand).toBe(true);
    expect(decision.score).toBe(100);
    expect(decision.actionable).toBe(true);
  });

  it('requires semantic evidence even when a caller supplies a high acoustic rank', () => {
    const evidence = {
      exactStopCommand: false,
      residualTokenCount: 0,
      residualRatio: 0,
      voicedMs: 1_200,
      peakDbAboveNoise: 30,
      signalVariationDb: 20,
      narrationSimilarity: 0,
    };

    expect(rankNarrationBargeInEvidence(evidence)).toBeGreaterThan(0);
    expect(narrationBargeInIsActionable(evidence)).toBe(false);
  });

  it('handles an empty transcript and overlap window without acoustic evidence', () => {
    const decision = analyzeNarrationBargeIn({
      transcript: '',
      referenceText: '',
      startPhrases: [],
      stopPhrases: [],
      pcm: Buffer.alloc(0),
      noiseProfile: { averageDbfs: -48, observedMs: 300 },
    });

    expect(decision).toMatchObject({
      actionable: false,
      score: 0,
      evidence: {
        residualRatio: 0,
        peakDbAboveNoise: 0,
        signalVariationDb: 0,
        voicedMs: 0,
      },
    });
  });

  it('guards inactive, stale, and malformed monitor input', () => {
    const monitor = new NarrationBargeInMonitor({ transcribe: vi.fn(), onEvidence: vi.fn() });

    monitor.observe(pcmFrame(1), 0);
    monitor.finish(1);
    monitor.reopenCleanLane();
    expect(monitor.promote(1)).toBeUndefined();

    monitor.begin({ generation: 2, text: 'working', startPhrases: [], stopPhrases: [] }, 10);
    expect(() => monitor.observe(Buffer.alloc(2), 10)).toThrow('PCM frames');
    monitor.finish(1);
    monitor.stop();
    expect(monitor.confirmed).toBe(false);
  });

  it('keeps overlap private until the lifecycle authority promotes it', async () => {
    const onEvidence = vi.fn();
    const transcribe = vi.fn(async () => 'The plan is ready hey doom please handle my new request');
    const monitor = new NarrationBargeInMonitor({ transcribe, onEvidence });
    monitor.begin(
      { generation: 3, text: 'The plan is ready', startPhrases: ['hey doom'], stopPhrases: ['stop speaking'] },
      0,
    );

    for (let index = 0; index < 60; index += 1) monitor.observe(pcmFrame(index % 3 === 0 ? 9_000 : 5_000), index * 20);

    await vi.waitFor(() => expect(onEvidence).toHaveBeenCalledOnce());
    expect(monitor.confirmed).toBe(false);
    const promoted = monitor.promote(3);
    expect(promoted).toHaveLength(60 * PCM_FRAME_BYTES);
    expect(monitor.confirmed).toBe(true);
    monitor.observe(pcmFrame(9_000), 1_300);
    expect(monitor.promote(3)).toBeUndefined();
    monitor.finish(3);
    expect(monitor.confirmed).toBe(true);
    monitor.reopenCleanLane();
    expect(monitor.confirmed).toBe(false);
  });

  it('discards command-only overlap without exposing narration tail PCM', async () => {
    const onEvidence = vi.fn();
    const monitor = new NarrationBargeInMonitor({
      transcribe: vi.fn(async () => 'The latest commit is four four eight stop speaking'),
      onEvidence,
    });
    monitor.begin(
      {
        generation: 5,
        text: 'The latest commit is 448900',
        startPhrases: ['hey doom'],
        stopPhrases: ['stop speaking'],
      },
      0,
    );
    for (let index = 0; index < 60; index += 1) monitor.observe(pcmFrame(7_000), index * 20);
    await vi.waitFor(() => expect(onEvidence).toHaveBeenCalledOnce());
    expect(onEvidence).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ evidence: expect.objectContaining({ exactStopCommand: true }) }),
    );

    expect(monitor.discard(5)).toBe(true);
    expect(monitor.confirmed).toBe(false);
    expect(monitor.promote(5)).toBeUndefined();
  });

  it('queues the newest probe while transcription is active and recovers from rejection', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const first = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const transcribe = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce('narration only');
    const onEvidence = vi.fn();
    const monitor = new NarrationBargeInMonitor({ transcribe, onEvidence });
    monitor.begin({ generation: 7, text: 'narration only', startPhrases: [], stopPhrases: [] }, 0);

    for (let index = 0; index < 90; index += 1) monitor.observe(pcmFrame(5_000), index * 20);
    expect(transcribe).toHaveBeenCalledOnce();
    rejectFirst?.(new Error('transcriber unavailable'));

    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
    expect(onEvidence).not.toHaveBeenCalled();
    monitor.finish(7);
  });
});
