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
