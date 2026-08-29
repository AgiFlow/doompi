import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessVoiceTranscript,
  VoiceTranscriptAdjudicator,
  type IVoiceTranscriptAdmissionModelClient,
  type VoiceTranscriptSignalEvidence,
} from '../src/services/transcriptAdmission.ts';

const strongEvidence: VoiceTranscriptSignalEvidence = {
  durationMs: 1_200,
  voicedMs: 800,
  classifierSpeechMs: 640,
  rmsDbfs: -34,
  peakDbfs: -18,
  signalVariationDb: 9,
  nonZeroRatio: 0.8,
  gapCount: 0,
  playbackOverlapMs: 0,
  classifier: 'client',
};

const clock = {
  clear: (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle),
  setTimeout: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> =>
    setTimeout(callback, milliseconds),
};

function assessment(overrides: Partial<Parameters<typeof assessVoiceTranscript>[0]> = {}) {
  return assessVoiceTranscript({
    transcript: 'run the focused tests',
    evidence: strongEvidence,
    observedAt: 10_000,
    narrationOverlap: false,
    narrationReferences: [],
    ...overrides,
  });
}

afterEach(() => vi.useRealTimers());

describe('voice transcript admission', () => {
  it('hard-rejects playback echo before model review despite strong audio evidence', () => {
    expect(
      assessment({
        transcript: 'The deployment completed successfully',
        narrationOverlap: true,
        narrationReferences: ['The deployment completed successfully'],
      }),
    ).toMatchObject({ action: 'reject', reason: 'narration_echo', score: 0 });
  });

  it('rejects normalized duplicates only inside the bounded recent-turn window', () => {
    const recentTranscripts = [{ text: 'Run the focused tests.', acceptedAt: 7_500 }];
    expect(assessment({ recentTranscripts })).toMatchObject({ action: 'reject', reason: 'duplicate' });
    expect(assessment({ observedAt: 10_001, recentTranscripts })).toMatchObject({ action: 'accept' });
  });

  it('hard-rejects a no-speech transcript and routes ambiguous evidence to review', () => {
    expect(
      assessment({
        evidence: {
          ...strongEvidence,
          voicedMs: 0,
          classifierSpeechMs: 0,
          rmsDbfs: -90,
          peakDbfs: -80,
          signalVariationDb: 0,
          nonZeroRatio: 0,
        },
      }),
    ).toMatchObject({ action: 'reject', reason: 'no_speech' });

    expect(
      assessment({
        evidence: {
          ...strongEvidence,
          voicedMs: 200,
          classifierSpeechMs: 100,
          rmsDbfs: -62,
          peakDbfs: -55,
          signalVariationDb: 0,
          nonZeroRatio: 0.3,
        },
      }),
    ).toMatchObject({ action: 'review', reason: 'review' });
  });

  it('routes a conflicting high score to the existing review path instead of accepting classifier-backed text', () => {
    const result = assessment({
      evidence: {
        ...strongEvidence,
        voicedMs: 0,
      },
    });

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result).toMatchObject({ action: 'review', reason: 'review' });
    expect(result.matchedGuards).toContain('evidence_conflict');
  });

  it('rejects deterministic MLX no-speech decoding evidence and reviews weaker decoding conflicts', () => {
    expect(
      assessment({
        evidence: {
          ...strongEvidence,
          asr: { noSpeechProbability: 0.82, averageLogProbability: -1.4, compressionRatio: 1.1 },
        },
      }),
    ).toMatchObject({ action: 'reject', reason: 'no_speech', matchedGuards: ['asr_no_speech'] });

    expect(
      assessment({
        evidence: {
          ...strongEvidence,
          asr: { noSpeechProbability: 0.55, averageLogProbability: -1.3, compressionRatio: 3.1 },
        },
      }),
    ).toMatchObject({ action: 'review', reason: 'review' });
  });

  it('accepts credible ASR plus PCM evidence when a classifier is unavailable', () => {
    expect(
      assessment({
        evidence: {
          ...strongEvidence,
          classifierSpeechMs: 0,
          classifier: 'energy',
          asr: {
            noSpeechProbability: 0.08,
            averageLogProbability: -0.3,
            compressionRatio: 1.2,
            speechDurationMs: 700,
          },
        },
      }),
    ).toMatchObject({ action: 'accept', reason: 'accepted' });
  });
  it.each(['stop', 'send it'])(
    'preserves a real short command with corroborating speech evidence: %s',
    (transcript) => {
      expect(
        assessment({ transcript, evidence: { ...strongEvidence, voicedMs: 160, classifierSpeechMs: 160 } }),
      ).toMatchObject({
        action: 'accept',
        reason: 'accepted',
      });
    },
  );

  it('preserves ordinary speech with corroborating classifier and PCM evidence', () => {
    expect(assessment()).toMatchObject({ action: 'accept', reason: 'accepted' });
  });
  it('treats missing signal evidence as no speech', () => {
    expect(
      assessVoiceTranscript({
        transcript: 'run the focused tests',
        observedAt: 10_000,
        narrationOverlap: false,
        narrationReferences: [],
      }),
    ).toMatchObject({ action: 'reject', reason: 'no_speech', score: 0 });
  });

  it('accepts only a grounded, bounded continuation summary from structured model output', async () => {
    const model: IVoiceTranscriptAdmissionModelClient = {
      complete: vi.fn(async () =>
        JSON.stringify({
          admit: true,
          narration: 'summarize',
          summary: 'The database migration remains blocked.',
          reason: 'user_speech',
        }),
      ),
    };
    const adjudicator = new VoiceTranscriptAdjudicator(model, clock);
    const overlap = assessment({
      transcript: 'The deployment is blocked by the database migration please run tests',
      narrationOverlap: true,
      narrationReferences: ['The deployment is blocked by the database migration'],
      evidence: { ...strongEvidence, playbackOverlapMs: 1_200 },
    });

    await expect(
      adjudicator.decide(
        { assessment: overlap, narrationText: 'The deployment is blocked by the database migration.' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      admit: true,
      continuationSummary: 'The database migration remains blocked.',
      reason: 'user_speech',
    });
    expect(model.complete).toHaveBeenCalledWith(
      expect.objectContaining({ cacheRetention: 'none', maxTokens: 192, signal: expect.any(AbortSignal) }),
    );
  });

  it('passes suspicious conflict evidence through the existing structured adjudicator', async () => {
    const model: IVoiceTranscriptAdmissionModelClient = {
      complete: vi.fn(async () =>
        JSON.stringify({ admit: false, narration: 'drop', summary: null, reason: 'no_speech' }),
      ),
    };
    const adjudicator = new VoiceTranscriptAdjudicator(model, clock);
    const conflicted = assessment({ evidence: { ...strongEvidence, voicedMs: 0 } });

    await expect(adjudicator.decide({ assessment: conflicted }, new AbortController().signal)).resolves.toEqual({
      admit: false,
      reason: 'no_speech',
    });
    expect(model.complete).toHaveBeenCalledOnce();
  });
  it.each([
    'not json',
    'x'.repeat(1_025),
    JSON.stringify([]),
    JSON.stringify({ admit: true, narration: 'drop', summary: null, reason: 'user_speech', extra: true }),
    JSON.stringify({ admit: 'yes', narration: 'drop', summary: null, reason: 'user_speech' }),
    JSON.stringify({ admit: true, narration: 'keep', summary: null, reason: 'user_speech' }),
    JSON.stringify({ admit: true, narration: 'drop', summary: null, reason: 'invalid' }),
    JSON.stringify({ admit: true, narration: 'drop', summary: 'unexpected', reason: 'user_speech' }),
    JSON.stringify({
      admit: false,
      narration: 'summarize',
      summary: 'The deployment remains blocked.',
      reason: 'echo',
    }),
    JSON.stringify({ admit: true, narration: 'summarize', summary: '', reason: 'user_speech' }),
    JSON.stringify({
      admit: true,
      narration: 'summarize',
      summary: 'Visit https://unsafe.example',
      reason: 'user_speech',
    }),
    JSON.stringify({ admit: true, narration: 'summarize', summary: 'Unrelated bananas.', reason: 'user_speech' }),
  ])('rejects invalid or unsafe adjudication output %#', async (output) => {
    const adjudicator = new VoiceTranscriptAdjudicator({ complete: async () => output }, clock);
    const overlap = assessment({ narrationOverlap: true, evidence: { ...strongEvidence, playbackOverlapMs: 1_200 } });
    await expect(
      adjudicator.decide(
        { assessment: overlap, narrationText: 'The deployment remains blocked.' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('aborts a model request at the bounded admission deadline', async () => {
    vi.useFakeTimers();
    let modelSignal: AbortSignal | undefined;
    const adjudicator = new VoiceTranscriptAdjudicator(
      {
        complete: async (request) => {
          modelSignal = request.signal;
          return new Promise<string>(() => undefined);
        },
      },
      clock,
      25,
    );
    const pending = adjudicator.decide({ assessment: assessment() }, new AbortController().signal);
    const rejection = expect(pending).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(modelSignal?.aborted).toBe(true);
  });
});
