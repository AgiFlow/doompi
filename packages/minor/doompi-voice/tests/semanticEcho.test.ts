import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alignNarrationSpan,
  type EchoProbeInput,
  type EchoProbeResult,
  EchoTailTimeline,
  extractNovelNarrationResidual,
  type IEchoProbeClassifier,
  matchStartPhrase,
  matchStopPhrase,
  normalizeEchoText,
  RollingEchoProbeCoordinator,
  SemanticEchoAdjudicator,
} from '../src/services/semanticEcho.ts';
import type { AudioActivityHistogram } from '../src/services/vad.ts';

const ACTIVITY: AudioActivityHistogram = {
  bucketMs: 100,
  buckets: [{ levelDbAboveNoise: 8, playbackOverlapMs: 80 }],
  durationMs: 100,
  noiseFloorDbfs: -54,
  speechThresholdDbfs: -42,
  voicedMs: 80,
  leadingSilenceMs: 10,
  trailingSilenceMs: 10,
  forcedClose: false,
};
const REFERENCE = {
  generation: 1,
  playback: {
    id: 7,
    kind: 'final' as const,
    text: 'I am checking the package and running focused tests now.',
    startedAt: 1_000,
    endedAt: 2_000,
  },
  echoTailUntil: 2_800,
};

function createProbe(overrides: Partial<EchoProbeInput> = {}): EchoProbeInput {
  return {
    generation: 1,
    revision: 1,
    transcript: 'a genuinely novel question',
    newUtterance: true,
    observedAt: 1_500,
    reference: REFERENCE,
    activity: ACTIVITY,
    stopPhrases: ['stop', 'please stop speaking now'],
    ...overrides,
  };
}

function createResult(input: EchoProbeInput, action: 'continue' | 'interrupt'): EchoProbeResult {
  return {
    generation: input.generation,
    revision: input.revision,
    action,
    classification: action === 'continue' ? 'residual_speech' : 'stop_phrase',
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('normalization and deterministic matching', () => {
  it('normalizes Unicode width, case, punctuation, and whitespace', () => {
    expect(normalizeEchoText('  ＨＥＹ， Doom!!!\nNow  ')).toBe('hey doom now');
    expect(normalizeEchoText('CAFÉ — déjà-vu')).toBe('café déjà vu');
  });

  it('recognizes a start cue only at a new transcript prefix', () => {
    expect(matchStartPhrase('Hey, DOOM please listen', ['hey doom'], true)).toEqual({
      tokenIndex: 0,
      tokenLength: 2,
      phraseTokenLength: 2,
    });
    expect(matchStartPhrase('noise hey doom', ['hey doom'], true)).toBeUndefined();
    expect(matchStartPhrase('hey doom', ['hey doom'], false)).toBeUndefined();
  });

  it('requires exact one-token controls and bounds longer phrase drift', () => {
    expect(matchStopPhrase('please stopped', ['stop'])).toBeUndefined();
    expect(matchStopPhrase('please stop now', ['stop'])).toBeDefined();
    expect(matchStopPhrase('noise attention assistant please', ['attention assistant now'])).toBeDefined();
    expect(matchStopPhrase('attention entirely different words', ['attention assistant now'])).toBeUndefined();
  });

  it('aligns only a local narration span within bounded token drift', () => {
    expect(alignNarrationSpan('checking the package', 'I am checking the package and tests')).toEqual({
      aligned: true,
      similarity: 1,
    });
    expect(alignNarrationSpan('quick brown fox over', 'the quick brown fox jumps over the fence')).toEqual({
      aligned: true,
      similarity: 0.8,
    });
    expect(alignNarrationSpan('cancel everything now', 'I am checking the package and tests').aligned).toBe(false);
  });

  it('classifies exact narration and isolated prompt fragments as echo without residual speech', () => {
    const narration = 'I heard deploy the fix. Should I send it? Say yes or no.';

    expect(extractNovelNarrationResidual(narration, narration)).toEqual({
      echoAligned: true,
      residualRuns: [],
      residual: '',
    });
    expect(extractNovelNarrationResidual('send it', narration)).toEqual({
      echoAligned: true,
      residualRuns: [],
      residual: '',
    });
  });

  it('extracts only a normalized suffix after an exact narration prefix', () => {
    const narration = 'I heard deploy the fix. Should I send it?';

    expect(extractNovelNarrationResidual(`${narration} YES!`, narration)).toEqual({
      echoAligned: true,
      residualRuns: ['yes'],
      residual: 'yes',
    });
    expect(extractNovelNarrationResidual(`${narration} replace with deploy tomorrow`, narration)).toEqual({
      echoAligned: true,
      residualRuns: ['replace with deploy tomorrow'],
      residual: 'replace with deploy tomorrow',
    });
  });

  it('does not strip unrelated or merely fuzzy leading speech as narration', () => {
    expect(extractNovelNarrationResidual('perhaps deploy tomorrow', 'Should I send deploy today?')).toEqual({
      echoAligned: false,
      residualRuns: ['perhaps deploy tomorrow'],
      residual: 'perhaps deploy tomorrow',
    });
  });
});

describe('SemanticEchoAdjudicator', () => {
  it('continues when configured controls are part of narration echo', async () => {
    const reference = {
      ...REFERENCE,
      playback: { ...REFERENCE.playback, text: 'Say stop speaking when you want me to finish.' },
    };
    await expect(
      new SemanticEchoAdjudicator().classify(
        createProbe({ transcript: 'stop speaking when you want me', reference }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ action: 'continue', classification: 'echo' });
  });

  it('interrupts only for an exact stop phrase in a non-echo residual run', async () => {
    const reference = {
      ...REFERENCE,
      playback: { ...REFERENCE.playback, text: 'I am checking the package now.' },
    };
    await expect(
      new SemanticEchoAdjudicator().classify(
        createProbe({ transcript: 'I am checking the package now please stop speaking now', reference }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ action: 'interrupt', classification: 'stop_phrase' });
    await expect(
      new SemanticEchoAdjudicator().classify(
        createProbe({ transcript: 'I am checking the package now hey doom add a test', reference }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ action: 'continue' });
  });

  it('never manufactures a stop phrase by joining residual runs across echo', async () => {
    const reference = {
      ...REFERENCE,
      playback: { ...REFERENCE.playback, text: 'the package is still being checked' },
    };
    await expect(
      new SemanticEchoAdjudicator().classify(
        createProbe({
          transcript: 'the package is still being checked please stop speaking now',
          reference,
          stopPhrases: ['please stop speaking now'],
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ action: 'interrupt', classification: 'stop_phrase' });
    await expect(
      new SemanticEchoAdjudicator().classify(
        createProbe({
          transcript: 'please stop the package is still being checked speaking now',
          reference,
          stopPhrases: ['please stop speaking now'],
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ action: 'continue' });
  });

  it('continues for absent, stale, or expired narration references', async () => {
    const adjudicator = new SemanticEchoAdjudicator();
    for (const probe of [
      createProbe({ reference: undefined }),
      createProbe({ observedAt: 2_801 }),
      createProbe({ reference: { ...REFERENCE, generation: 2 } }),
    ]) {
      await expect(adjudicator.classify(probe, new AbortController().signal)).resolves.toMatchObject({
        action: 'continue',
        classification: 'no_reference',
      });
    }
  });

  it('ignores cancelled work', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new SemanticEchoAdjudicator().classify(createProbe(), controller.signal)).resolves.toMatchObject({
      action: 'ignore',
      classification: 'stale',
    });
  });
});

describe('EchoTailTimeline', () => {
  it('tracks playback and bounded echo-tail timing while rejecting stale finishes', () => {
    const timeline = new EchoTailTimeline(500);
    timeline.begin(3, { id: 4, kind: 'final', text: 'private narration', startedAt: 1_000 });
    expect(timeline.playbackOverlapMs(900, 1_100)).toBe(100);
    expect(timeline.finish(2, 4, 1_500)).toBe(false);
    expect(timeline.finish(3, 99, 1_500)).toBe(false);
    expect(timeline.finish(3, 4, 1_500)).toBe(true);
    expect(timeline.playbackOverlapMs(1_400, 2_100)).toBe(600);
    expect(timeline.current(2_000)?.echoTailUntil).toBe(2_000);
    expect(timeline.current(2_001)).toBeUndefined();
  });
});

describe('RollingEchoProbeCoordinator', () => {
  it('deduplicates normalized transcript revisions without invalidating active work', async () => {
    let finish: ((result: EchoProbeResult) => void) | undefined;
    const classifier: IEchoProbeClassifier = {
      classify: vi.fn((_input) => new Promise<EchoProbeResult>((resolve) => (finish = resolve))),
    };
    const coordinator = new RollingEchoProbeCoordinator(classifier);
    coordinator.beginGeneration(1);
    const input = createProbe({ revision: 1, transcript: 'Hello, WORLD' });
    const first = coordinator.submit(input);
    await expect(coordinator.submit(createProbe({ revision: 2, transcript: 'hello world' }))).resolves.toMatchObject({
      action: 'ignore',
      classification: 'duplicate',
    });
    finish?.(createResult(input, 'continue'));
    await expect(first).resolves.toMatchObject({ action: 'continue', revision: 1 });
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it('keeps one active and only the latest pending revision under pressure', async () => {
    const resolvers: Array<(result: EchoProbeResult) => void> = [];
    const classifier: IEchoProbeClassifier = {
      classify: vi.fn((_input) => new Promise<EchoProbeResult>((resolve) => resolvers.push(resolve))),
    };
    const coordinator = new RollingEchoProbeCoordinator(classifier);
    coordinator.beginGeneration(1);
    const input1 = createProbe({ revision: 1, transcript: 'first revision' });
    const input2 = createProbe({ revision: 2, transcript: 'second revision' });
    const input3 = createProbe({ revision: 3, transcript: 'latest revision' });
    const first = coordinator.submit(input1);
    const second = coordinator.submit(input2);
    const third = coordinator.submit(input3);

    await expect(second).resolves.toMatchObject({ action: 'ignore', classification: 'pressure' });
    expect(coordinator.state()).toMatchObject({ activeRevision: 1, pendingRevision: 3, highestRevision: 3 });
    resolvers[0]?.(createResult(input1, 'continue'));
    await expect(first).resolves.toMatchObject({ action: 'ignore', classification: 'stale' });
    await vi.waitFor(() => expect(classifier.classify).toHaveBeenCalledTimes(2));
    resolvers[1]?.(createResult(input3, 'continue'));
    await expect(third).resolves.toMatchObject({ action: 'continue', revision: 3 });
  });

  it('keeps narration playing when an isolated classifier throws', async () => {
    const classifier: IEchoProbeClassifier = {
      classify: vi.fn(async () => {
        throw new Error('classifier unavailable');
      }),
    };
    const coordinator = new RollingEchoProbeCoordinator(classifier);
    coordinator.beginGeneration(1);

    await expect(coordinator.submit(createProbe())).resolves.toMatchObject({
      action: 'continue',
      classification: 'classifier_error',
    });
  });

  it('rejects stale generations and ignores late completion after rollover', async () => {
    let finish: ((result: EchoProbeResult) => void) | undefined;
    const classifier: IEchoProbeClassifier = {
      classify: vi.fn((_input) => new Promise<EchoProbeResult>((resolve) => (finish = resolve))),
    };
    const coordinator = new RollingEchoProbeCoordinator(classifier);
    coordinator.beginGeneration(4);
    const input = createProbe({ generation: 4, revision: 1, transcript: 'active work' });
    const pending = coordinator.submit(input);
    await expect(coordinator.submit(createProbe({ generation: 3, revision: 2 }))).resolves.toMatchObject({
      action: 'ignore',
      classification: 'stale',
    });
    coordinator.beginGeneration(5);
    await expect(pending).resolves.toMatchObject({ action: 'ignore', classification: 'stale' });
    finish?.(createResult(input, 'interrupt'));
    await expect(coordinator.submit(createProbe({ generation: 5, revision: 0 }))).resolves.toMatchObject({
      action: 'ignore',
      classification: 'stale',
    });
  });
});
