import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceWorkerAutoCaptureController,
  type VoiceWorkerAutoCaptureTelemetrySink,
} from '../src/adapters/process/voiceWorkerAutoCaptureController.ts';
import type { VoiceWorkerClientOptions } from '../src/adapters/process/voiceWorkerClient.ts';
import type { VoiceWorkerSessionClient } from '../src/adapters/process/voiceWorkerSessionController.ts';
import type { IVoiceCommandCorrector, VoiceCommandContext } from '../src/services/commandCorrection.ts';
import type { IVoiceTurnFallbackNarrator } from '../src/services/fallbackNarration.ts';
import type {
  IVoiceTranscriptAdjudicator,
  VoiceTranscriptSignalEvidence,
} from '../src/services/transcriptAdmission.ts';
import {
  VOICE_WORKER_PROTOCOL_VERSION,
  type VoiceCandidateOutcome,
  type VoiceWorkerEventPayload,
} from '../src/services/voiceWorkerProtocol.ts';
import type { AutoCaptureUi, IClock, ITtsAdapter, TtsPlaybackResult } from '../src/types/index.ts';

const config: ResolvedVoiceConfig = {
  engine: 'mlx-whisper',
  language: 'en',
  recorder: { device: 'default' },
  adapters: { 'mlx-whisper': { model: { id: 'whisper' } } },
  autoCapture: {
    model: 'provider/model',
    startPhrases: ['computer'],
    stopPhrases: ['stop listening'],
    utteranceIdleMs: 3_000,
    // The shipped defaults carry the original phrases alongside the new ones, so these
    // cases double as the backward-compatibility proof for `doom prompt` / `doom send`.
    composeOpenPhrases: ['hey doom', 'doom prompt'],
    composeSendPhrases: ["that's it", 'doom send'],
    composeCancelPhrases: ['doom cancel', 'scratch that'],
    composeUtteranceIdleMs: 1_200,
    composeNudgeMs: 10_000,
    transcriptionTimeoutMs: 15_000,
    tts: { engine: 'macos-say' },
  },
};

type Identity = { sessionId: string; captureId: string; turnId: string };

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

const ambiguousEvidence: VoiceTranscriptSignalEvidence = {
  ...strongEvidence,
  voicedMs: 200,
  classifierSpeechMs: 100,
  rmsDbfs: -62,
  peakDbfs: -55,
  signalVariationDb: 0,
  nonZeroRatio: 0.3,
};

function clock(): IClock {
  return {
    now: () => Date.now(),
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clear: (handle) => clearTimeout(handle),
  };
}

function harness(
  overrides: {
    loadedConfig?: ResolvedVoiceConfig;
    manualState?: 'idle' | 'recording' | 'transcribing';
    start?: () => Promise<void>;
    shutdown?: () => Promise<void>;
    telemetrySink?: VoiceWorkerAutoCaptureTelemetrySink;
    corrector?: IVoiceCommandCorrector;
    adjudicator?: IVoiceTranscriptAdjudicator;
    fallbackNarrator?: IVoiceTurnFallbackNarrator;
    commandContext?: () => VoiceCommandContext | undefined;
  } = {},
) {
  let options: VoiceWorkerClientOptions | undefined;
  let eventSequence = 0;
  const captures: Identity[] = [];
  const playbackCompletions: Array<(result: TtsPlaybackResult) => void> = [];
  const playbackAborts: Array<ReturnType<typeof vi.fn>> = [];
  const client: VoiceWorkerSessionClient = {
    start: vi.fn(overrides.start ?? (async () => undefined)),
    beginCapture: vi.fn((input) => captures.push(input)),
    finalizeCapture: vi.fn(),
    cancelCapture: vi.fn(),
    acknowledgeCandidate: vi.fn(),
    setPlaybackState: vi.fn(),
    confirmBargeIn: vi.fn(),
    shutdown: vi.fn(overrides.shutdown ?? (async () => undefined)),
  };
  const deliver = vi.fn();
  const ui: AutoCaptureUi = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setIndicator: vi.fn(),
  };
  const tts: ITtsAdapter = {
    preflight: vi.fn(),
    speak: vi.fn((request) => {
      let settled = false;
      let complete!: (result: TtsPlaybackResult) => void;
      const finish = (outcome: TtsPlaybackResult['outcome']): void => {
        if (settled) return;
        settled = true;
        complete({
          outcome,
          reference: { ...request, startedAt: Date.now(), endedAt: Date.now() },
          process: { code: outcome === 'failed' ? 1 : 0, stdout: '', stderr: '' },
        });
      };
      const completion = new Promise<TtsPlaybackResult>((resolve) => {
        complete = resolve;
      });
      playbackCompletions.push((result) => {
        if (settled) return;
        settled = true;
        complete(result);
      });
      const abort = vi.fn(async () => finish('aborted'));
      playbackAborts.push(abort);
      return {
        reference: { id: request.id, kind: request.kind, text: request.text, startedAt: Date.now() },
        completion,
        stop: vi.fn(async () => finish('stopped')),
        abort,
      };
    }),
  };
  const resolveCommandCorrector = vi.fn(async () => overrides.corrector);
  const resolveTranscriptAdjudicator = vi.fn(async () => overrides.adjudicator);
  const fallbackNarrator: IVoiceTurnFallbackNarrator =
    overrides.fallbackNarrator ??
    ({
      create: vi.fn(async (finalResponse: string) => ({ text: finalResponse, source: 'deterministic' as const })),
    } satisfies IVoiceTurnFallbackNarrator);
  const resolveFallbackNarrator = vi.fn(async () => fallbackNarrator);
  const controller = new VoiceWorkerAutoCaptureController({
    loadConfig: () => overrides.loadedConfig ?? config,
    resolveCommandCorrector,
    resolveTranscriptAdjudicator,
    resolveFallbackNarrator,
    tts,
    clock: clock(),
    deliver,
    manualState: () => overrides.manualState ?? 'idle',
    ...(overrides.commandContext ? { commandContext: overrides.commandContext } : {}),
    clientFactory: (createdOptions) => {
      options = createdOptions;
      return client;
    },
    ...(overrides.telemetrySink ? { telemetrySink: overrides.telemetrySink } : {}),
  });
  const emit = (payload: VoiceWorkerEventPayload): void => {
    options?.onEvent({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: eventSequence,
      ...payload,
    });
    eventSequence += 1;
  };
  const current = (): Identity => {
    const capture = captures.at(-1);
    if (!capture) throw new Error('capture unavailable');
    return capture;
  };
  const ready = (identity = current()): void =>
    emit({ kind: 'capture-state', sessionId: identity.sessionId, captureId: identity.captureId, state: 'listening' });
  const speech = (identity = current()): void =>
    emit({ kind: 'capture-state', sessionId: identity.sessionId, captureId: identity.captureId, state: 'speech' });
  const endpoint = (identity = current()): void => emit({ kind: 'endpoint-reached', ...identity });
  const drained = (identity = current(), revision = 1): void => emit({ kind: 'drained', ...identity, revision });
  const candidate = (
    identity: Identity,
    transcript: string,
    revision = 1,
    evidence?: VoiceTranscriptSignalEvidence,
  ): void =>
    emit({
      kind: 'transcript-candidate',
      ...identity,
      revision,
      transcript,
      final: true,
      ...(evidence ? { evidence } : {}),
    });
  const acknowledge = (identity: Identity, revision: number, outcome: Exclude<VoiceCandidateOutcome, 'retry'>): void =>
    emit({ kind: 'candidate-acknowledged', ...identity, revision, outcome });
  const durationLimit = (identity = current()): void =>
    emit({ kind: 'failure', ...identity, code: 'capture_duration_limit', recoverable: true });
  const exhaust = (): void => options?.onExhausted?.('heartbeat');
  const finishPlayback = (outcome: TtsPlaybackResult['outcome'] = 'completed'): void => {
    const complete = playbackCompletions.shift();
    complete?.({
      outcome,
      reference: { id: 1, kind: 'final', text: 'Safe spoken update', startedAt: 0, endedAt: 1 },
      process: { code: outcome === 'failed' ? 1 : 0, stdout: '', stderr: '' },
    });
  };
  return {
    controller,
    client,
    deliver,
    ui,
    tts,
    resolveCommandCorrector,
    resolveTranscriptAdjudicator,
    resolveFallbackNarrator,
    fallbackNarrator,
    captures,
    playbackAborts,
    emit,
    current,
    ready,
    speech,
    endpoint,
    drained,
    candidate,
    acknowledge,
    durationLimit,
    exhaust,
    finishPlayback,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function enable(h: ReturnType<typeof harness>): Promise<void> {
  await h.controller.toggle(h.ui);
  h.ready();
  expect(h.controller.state).toBe('active');
}

async function finishTurn(
  h: ReturnType<typeof harness>,
  transcript: string,
  revision = 1,
  evidence: VoiceTranscriptSignalEvidence = strongEvidence,
): Promise<{ identity: Identity; outcome: Exclude<VoiceCandidateOutcome, 'retry'> }> {
  const identity = h.current();
  h.speech(identity);
  h.endpoint(identity);
  h.drained(identity, revision);
  h.candidate(identity, transcript, revision, evidence);
  await flush();
  const acknowledgement = vi.mocked(h.client.acknowledgeCandidate).mock.calls.at(-1);
  if (!acknowledgement) throw new Error('acknowledgement unavailable');
  return { identity, outcome: acknowledgement[3] as Exclude<VoiceCandidateOutcome, 'retry'> };
}

describe('VoiceWorkerAutoCaptureController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gates direct and external narration on active autonomous voice', async () => {
    const h = harness();

    await expect(h.controller.narrateAgent('ignored while disabled')).resolves.toBe('interrupted');
    await expect(h.controller.narrateFallback('ignored while disabled')).resolves.toBe('interrupted');
    expect(h.tts.speak).not.toHaveBeenCalled();

    await enable(h);
    const narration = h.controller.narrateExternal('Caller-owned narration.');

    expect(h.tts.speak).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clarification', text: 'Caller-owned narration.' }),
    );
    h.finishPlayback();
    await expect(narration).resolves.toBe('completed');
    expect(h.resolveCommandCorrector).toHaveBeenCalledWith('provider/model');
  });

  it('mutes autonomous capture without interrupting narration and unmutes into a fresh capture', async () => {
    const h = harness();
    await enable(h);
    const mutedIdentity = h.current();
    const narration = h.controller.narrateAgent('Narration keeps playing.');
    await flush();

    h.controller.setMicrophoneMuted(true);

    expect(h.controller.state).toBe('active');
    expect(h.controller.microphoneMuted).toBe(true);
    expect(h.client.cancelCapture).toHaveBeenCalledWith(mutedIdentity.sessionId, mutedIdentity.captureId);
    expect(h.client.beginCapture).toHaveBeenCalledOnce();
    expect(h.playbackAborts[0]).not.toHaveBeenCalled();
    expect(h.ui.setStatus).toHaveBeenLastCalledWith('voice auto: narrating, microphone muted');

    h.speech(mutedIdentity);
    h.durationLimit(mutedIdentity);
    expect(h.client.beginCapture).toHaveBeenCalledOnce();
    h.controller.setMicrophoneMuted(false);
    const freshIdentity = h.current();

    expect(h.controller.microphoneMuted).toBe(false);
    expect(freshIdentity.captureId).not.toBe(mutedIdentity.captureId);
    expect(h.client.beginCapture).toHaveBeenCalledTimes(2);
    h.ready(freshIdentity);
    h.finishPlayback();
    await expect(narration).resolves.toBe('completed');

    h.controller.setMicrophoneMuted(true);
    expect(h.controller.microphoneMuted).toBe(true);
    await h.controller.deactivate(h.ui);
    await flush();
    expect(h.controller.microphoneMuted).toBe(false);
  });

  it('generates omitted-turn fallback speech and routes it through final-priority playback', async () => {
    const create = vi.fn(async () => ({ text: 'Fallback spoken summary.', source: 'model' as const }));
    const h = harness({ fallbackNarrator: { create } });
    await enable(h);

    const narration = h.controller.narrateFallback('A long final assistant response.');
    await flush();

    expect(h.resolveFallbackNarrator).toHaveBeenCalledWith('provider/model');
    expect(create).toHaveBeenCalledWith('A long final assistant response.', expect.any(AbortSignal));
    expect(h.tts.speak).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'final', text: 'Fallback spoken summary.' }),
    );
    h.finishPlayback();
    await expect(narration).resolves.toBe('completed');
  });

  it('records model degradation while still playing deterministic fallback speech', async () => {
    const generationError = new Error('model unavailable');
    const telemetrySink: VoiceWorkerAutoCaptureTelemetrySink = {
      recordEvent: vi.fn(),
      recordError: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const h = harness({
      telemetrySink,
      fallbackNarrator: {
        create: vi.fn(async () => ({
          text: 'Deterministic fallback.',
          source: 'model-fallback' as const,
          generationError,
        })),
      },
    });
    await enable(h);

    const narration = h.controller.narrateFallback('Long final response.');
    await flush();

    expect(telemetrySink.recordError).toHaveBeenCalledWith(
      'doom_voice.fallback_narration_generation_failed',
      generationError,
      { 'narration.fallback_source': 'model-fallback' },
    );
    expect(h.tts.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'Deterministic fallback.' }));
    h.finishPlayback();
    await expect(narration).resolves.toBe('completed');
  });

  it('cancels fallback generation when autonomous Voice deactivates', async () => {
    let generationSignal: AbortSignal | undefined;
    const create = vi.fn(
      (_finalResponse: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          generationSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const h = harness({ fallbackNarrator: { create } });
    await enable(h);

    const narration = h.controller.narrateFallback('Pending final response.');
    await flush();
    await h.controller.deactivate(h.ui);

    await expect(narration).resolves.toBe('interrupted');
    await vi.waitFor(() => expect(h.controller.state).toBe('disabled'));
    expect(generationSignal?.aborted).toBe(true);
    expect(h.tts.speak).not.toHaveBeenCalled();
  });

  it('cancels fallback generation when autonomous Voice shuts down', async () => {
    let generationSignal: AbortSignal | undefined;
    const create = vi.fn(
      (_finalResponse: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          generationSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const h = harness({ fallbackNarrator: { create } });
    await enable(h);

    const narration = h.controller.narrateFallback('Pending final response.');
    await flush();
    await h.controller.shutdown(h.ui);

    await expect(narration).resolves.toBe('interrupted');
    expect(generationSignal?.aborted).toBe(true);
    expect(h.tts.speak).not.toHaveBeenCalled();
  });

  it('processes twenty automatic endpoints, delivers exact text once, and restarts exactly once per turn', async () => {
    const h = harness();
    await enable(h);

    for (let index = 1; index <= 20; index += 1) {
      const transcript = `computer run check ${index}`;
      const { identity, outcome } = await finishTurn(h, transcript, index);
      expect(outcome).toBe('committed');
      expect(h.client.finalizeCapture).toHaveBeenLastCalledWith(
        identity.sessionId,
        identity.captureId,
        'soft-endpoint',
      );
      expect(h.deliver).toHaveBeenNthCalledWith(index, `run check ${index}`);
      h.acknowledge(identity, index, outcome);
      await flush();
      h.ready();
    }

    expect(h.deliver).toHaveBeenCalledTimes(20);
    expect(vi.mocked(h.client.beginCapture).mock.calls[0]?.[0]).not.toHaveProperty('type');
    expect(h.client.finalizeCapture).toHaveBeenCalledTimes(20);
    expect(h.client.acknowledgeCandidate).toHaveBeenCalledTimes(20);
    expect(h.client.beginCapture).toHaveBeenCalledTimes(21);
  });

  it('discards a final candidate without audio evidence', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'computer do not trust this', 1);
    await flush();

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.client.acknowledgeCandidate).toHaveBeenCalledWith(identity.sessionId, identity.turnId, 1, 'discarded');
  });

  it('discards playback overlap that lacks current barge-in authorization', async () => {
    const decide = vi.fn();
    const h = harness({ adjudicator: { decide } });
    await enable(h);

    const result = await finishTurn(h, 'computer reject speaker echo', 1, {
      ...strongEvidence,
      playbackOverlapMs: 400,
    });

    expect(result.outcome).toBe('discarded');
    expect(decide).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('rejects a repeated admitted transcript inside the duplicate window', async () => {
    const h = harness();
    await enable(h);

    const first = await finishTurn(h, 'computer run focused tests', 1, strongEvidence);
    expect(first.outcome).toBe('committed');
    expect(h.deliver).toHaveBeenCalledWith('run focused tests');
    h.acknowledge(first.identity, 1, first.outcome);
    await flush();
    h.ready();

    const repeated = await finishTurn(h, 'computer run focused tests', 2, strongEvidence);
    expect(repeated.outcome).toBe('discarded');
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('uses the safe local rejection fallback when ambiguous model review fails', async () => {
    const decide = vi.fn(async () => {
      throw new Error('invalid model output');
    });
    const h = harness({ adjudicator: { decide } });
    await enable(h);

    const result = await finishTurn(h, 'uncertain request', 1, ambiguousEvidence);

    expect(decide).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('discarded');
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('aborts model admission on toggle-off and discards the same ambiguous evidence as model failure', async () => {
    let decideSignal: AbortSignal | undefined;
    const decide = vi.fn(
      (_input, signal: AbortSignal) =>
        new Promise<never>(() => {
          decideSignal = signal;
        }),
    );
    const h = harness({ adjudicator: { decide } });
    await enable(h);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'uncertain request', 1, ambiguousEvidence);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());

    await h.controller.toggle(h.ui);
    await flush();

    expect(decideSignal?.aborted).toBe(true);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.client.acknowledgeCandidate).toHaveBeenCalledWith(identity.sessionId, identity.turnId, 1, 'discarded');
    h.acknowledge(identity, 1, 'discarded');
    await flush();
    expect(h.controller.state).toBe('disabled');
  });

  it('finishes a corroborated reviewed turn when toggle-off aborts model admission', async () => {
    let decideSignal: AbortSignal | undefined;
    const decide = vi.fn(
      (_input, signal: AbortSignal) =>
        new Promise<never>(() => {
          decideSignal = signal;
        }),
    );
    const h = harness({ adjudicator: { decide } });
    await enable(h);
    const identity = h.current();
    const narration = h.controller.narrateAgent('Safe spoken update');
    await flush();
    h.emit({
      kind: 'barge-in-evidence',
      ...identity,
      playbackGeneration: 1,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: true,
        classifierConfirmed: true,
        classifierSpeechMs: 640,
        residualTokenCount: 4,
        residualRatio: 1,
        voicedMs: 800,
        peakDbAboveNoise: 12,
        signalVariationDb: 9,
        narrationSimilarity: 0,
      },
    });
    await flush();
    await expect(narration).resolves.toBe('interrupted');
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'computer preserve confirmed words', 1, { ...strongEvidence, playbackOverlapMs: 400 });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());

    await h.controller.toggle(h.ui);
    await flush();

    expect(decideSignal?.aborted).toBe(true);
    expect(h.deliver).toHaveBeenCalledWith('preserve confirmed words');
    expect(h.client.acknowledgeCandidate).toHaveBeenCalledWith(identity.sessionId, identity.turnId, 1, 'committed');
    h.acknowledge(identity, 1, 'committed');
    await flush();
    expect(h.controller.state).toBe('disabled');
  });

  it('ignores stale adjudication after shutdown and aborts its model signal', async () => {
    let decideSignal: AbortSignal | undefined;
    let resolveDecision!: (decision: { admit: boolean; reason: 'user_speech' }) => void;
    const decide = vi.fn(
      (_input, signal: AbortSignal) =>
        new Promise<{ admit: boolean; reason: 'user_speech' }>((resolve) => {
          decideSignal = signal;
          resolveDecision = resolve;
        }),
    );
    const h = harness({ adjudicator: { decide } });
    await enable(h);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'uncertain request', 1, ambiguousEvidence);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());

    await h.controller.shutdown(h.ui);
    resolveDecision({ admit: true, reason: 'user_speech' });
    await flush();

    expect(decideSignal?.aborted).toBe(true);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('plays a grounded overlap summary before delivering classifier-confirmed user speech', async () => {
    const decide = vi.fn(async () => ({
      admit: true,
      continuationSummary: 'The plan was ready.',
      reason: 'user_speech' as const,
    }));
    const h = harness({ adjudicator: { decide } });
    await enable(h);
    const identity = h.current();
    const narration = h.controller.narrateAgent('The plan is ready');
    await flush();
    h.emit({
      kind: 'barge-in-evidence',
      ...identity,
      playbackGeneration: 1,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: true,
        classifierConfirmed: true,
        classifierSpeechMs: 160,
        residualTokenCount: 4,
        residualRatio: 0.5,
        voicedMs: 800,
        peakDbAboveNoise: 12,
        signalVariationDb: 5,
        narrationSimilarity: 0.2,
      },
    });
    await flush();
    await expect(narration).resolves.toBe('interrupted');

    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'The plan is ready please run all tests', 1, { ...strongEvidence, playbackOverlapMs: 1_200 });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.tts.speak).toHaveBeenCalledTimes(2));
    expect(h.tts.speak).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'clarification', text: 'The plan was ready.' }),
    );
    expect(h.deliver).not.toHaveBeenCalled();

    h.finishPlayback();
    h.finishPlayback();
    await flush();

    expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledWith('please run all tests');
  });

  it('shortens the endpoint window for the turns that follow an opened draft', async () => {
    const h = harness();
    await enable(h);
    const capturesOf = () => vi.mocked(h.client.beginCapture).mock.calls.map(([input]) => input.utteranceIdleMs);

    // The first capture predates any draft, so it uses the ordinary window.
    expect(capturesOf()).toEqual([3_000]);

    const opened = await finishTurn(h, 'doom prompt Refactor voice.', 1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();

    // Once collecting, a short command has to be able to finalize as its own turn, which
    // it cannot do behind a three-second silence.
    expect(capturesOf().at(-1)).toBe(1_200);

    const sent = await finishTurn(h, 'Doom, send.', 2);
    h.acknowledge(sent.identity, 2, sent.outcome);
    await flush();
    h.ready();
    expect(capturesOf().at(-1)).toBe(3_000);
  });

  it('buffers multiple finalized segments until standalone Doom send', async () => {
    const h = harness();
    await enable(h);

    const opened = await finishTurn(h, 'doom prompt Refactor voice.', 1);
    expect(opened.outcome).toBe('committed');
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      'Voice composition started. Say "that\'s it" to submit, or say "doom cancel" to discard.',
      'info',
    );
    h.candidate(opened.identity, 'doom prompt Refactor voice.', 1);
    await flush();
    expect(h.client.acknowledgeCandidate).toHaveBeenCalledTimes(1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();

    h.durationLimit();
    await flush();
    h.ready();

    const appended = await finishTurn(h, 'Keep manual dictation unchanged.', 2);
    expect(appended.outcome).toBe('committed');
    expect(h.deliver).not.toHaveBeenCalled();
    h.acknowledge(appended.identity, 2, appended.outcome);
    await flush();
    h.ready();

    const sent = await finishTurn(h, 'Doom, send.', 3);
    expect(sent.outcome).toBe('committed');
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledWith('Refactor voice. Keep manual dictation unchanged.', 'queuedFollowUp');
  });

  it('retains a composed draft after synchronous send failure and allows retry', async () => {
    const h = harness();
    h.deliver.mockImplementationOnce(() => {
      throw new Error('busy race');
    });
    await enable(h);

    const opened = await finishTurn(h, 'doom prompt Retain this draft.', 1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();

    const failed = await finishTurn(h, 'doom send', 2);
    expect(failed.outcome).toBe('discarded');
    expect(h.ui.notify).toHaveBeenCalledWith('Voice composition was not accepted; the draft was retained.', 'warning');
    h.acknowledge(failed.identity, 2, failed.outcome);
    await flush();
    h.ready();

    const retried = await finishTurn(h, 'doom send', 3);
    expect(retried.outcome).toBe('committed');
    expect(h.deliver).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenLastCalledWith('Retain this draft.', 'queuedFollowUp');
  });

  it('keeps an empty composition active until content or explicit cancel', async () => {
    const h = harness();
    await enable(h);

    const opened = await finishTurn(h, 'doom prompt', 1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();

    const emptySend = await finishTurn(h, 'doom send', 2);
    expect(emptySend.outcome).toBe('discarded');
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      'Voice composition is empty. Add content or say "doom cancel" to discard.',
      'warning',
    );
    h.acknowledge(emptySend.identity, 2, emptySend.outcome);
    await flush();
    h.ready();

    const cancelled = await finishTurn(h, 'doom cancel', 3);
    expect(cancelled.outcome).toBe('discarded');
    expect(h.ui.notify).toHaveBeenCalledWith('Voice composition draft discarded.', 'info');
  });

  it('corrects composition content without sending control phrases to the model', async () => {
    const correct = vi.fn(async (input: { transcript: string }) => input.transcript.replace('doom pie', 'DoomPi'));
    const h = harness({ corrector: { correct } });
    await enable(h);

    const opened = await finishTurn(h, 'doom prompt update doom pie voice', 1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();
    await finishTurn(h, 'doom send', 2);

    expect(correct).toHaveBeenCalledOnce();
    expect(correct).toHaveBeenCalledWith(
      { transcript: 'update doom pie voice', context: undefined },
      expect.any(AbortSignal),
    );
    expect(h.deliver).toHaveBeenCalledWith('update DoomPi voice', 'queuedFollowUp');
  });

  it('rejects a segment that would exceed the bounded composition draft', async () => {
    const h = harness();
    await enable(h);

    const opened = await finishTurn(h, `doom prompt ${'x'.repeat(4_000)}`, 1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();
    for (let revision = 2; revision <= 8; revision += 1) {
      const appended = await finishTurn(h, `segment-${revision} ${'x'.repeat(4_080)}`, revision);
      expect(appended.outcome).toBe('committed');
      h.acknowledge(appended.identity, revision, appended.outcome);
      await flush();
      h.ready();
    }
    const result = await finishTurn(h, `overflow ${'x'.repeat(200)}`, 9);

    expect(result.outcome).toBe('discarded');
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      'Voice composition is limited to 32768 characters; the latest segment was not added.',
      'warning',
    );
  });

  it('discards a session-scoped draft when autonomous voice is disabled', async () => {
    const h = harness();
    await enable(h);
    const opened = await finishTurn(h, 'doom prompt unsent content', 1);
    h.acknowledge(opened.identity, 1, opened.outcome);
    await flush();
    h.ready();

    await h.controller.toggle(h.ui);
    await flush();

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      'Voice composition draft discarded while stopping autonomous voice.',
      'warning',
    );
    expect(h.controller.state).toBe('disabled');
  });

  it('corrects a context-grounded term after deterministic control-phrase policy', async () => {
    const correct = vi.fn(async (input: { transcript: string; context?: VoiceCommandContext }) =>
      input.transcript.replace('doom pie', 'DoomPi'),
    );
    const context = { tasks: ['Update DoomPi voice commands'] };
    const h = harness({
      corrector: { correct },
      commandContext: () => context,
    });
    await enable(h);

    await finishTurn(h, 'computer update doom pie voice', 1);

    expect(correct).toHaveBeenCalledWith({ transcript: 'update doom pie voice', context }, expect.any(AbortSignal));
    expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledWith('update DoomPi voice');
  });

  it('fails open to the policy transcript when correction is invalid or unavailable', async () => {
    const correct = vi.fn(async () => Promise.reject(new Error('invalid correction output')));
    const h = harness({
      corrector: { correct },
      commandContext: () => ({ tasks: ['Untrusted task wording'] }),
    });
    await enable(h);

    await finishTurn(h, 'computer preserve my exact request', 1);

    expect(h.deliver).toHaveBeenCalledWith('preserve my exact request');
  });

  it('aborts correction on toggle-off and finishes the confirmed turn with unchanged text', async () => {
    let correctionSignal: AbortSignal | undefined;
    const correct = vi.fn((_input: { transcript: string }, signal: AbortSignal) => {
      correctionSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const h = harness({
      corrector: { correct },
      commandContext: () => ({ tasks: ['DoomPi correction'] }),
    });
    await enable(h);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'computer preserve this request', 1, strongEvidence);
    await flush();

    await h.controller.toggle(h.ui);
    await flush();

    expect(correctionSignal?.aborted).toBe(true);
    expect(h.deliver).toHaveBeenCalledWith('preserve this request');
    h.acknowledge(identity, 1, 'committed');
    await flush();
    expect(h.controller.state).toBe('disabled');
  });

  it('does not reach disabled before delayed hard-stop cleanup settles', async () => {
    let resolveShutdown!: () => void;
    const shutdownBarrier = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const h = harness({ shutdown: () => shutdownBarrier });
    await enable(h);

    const shuttingDown = h.controller.shutdown(h.ui);
    await flush();
    expect(h.controller.state).not.toBe('disabled');
    expect(h.client.shutdown).toHaveBeenCalledWith('session-shutdown');

    resolveShutdown();
    await shuttingDown;
    expect(h.controller.state).toBe('disabled');
  });

  it('aborts correction on hard shutdown without delivering a new turn', async () => {
    let correctionSignal: AbortSignal | undefined;
    const correct = vi.fn((_input: { transcript: string }, signal: AbortSignal) => {
      correctionSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const h = harness({
      corrector: { correct },
      commandContext: () => ({ tasks: ['DoomPi correction'] }),
    });
    await enable(h);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'computer do not deliver after shutdown', 1, strongEvidence);
    await flush();

    await h.controller.shutdown(h.ui);
    await flush();

    expect(correctionSignal?.aborted).toBe(true);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.controller.state).toBe('disabled');
  });

  it('rotates an idle duration-limited capture and finalizes one with confirmed speech', async () => {
    const h = harness();
    await enable(h);
    const idleIdentity = h.current();

    h.durationLimit(idleIdentity);
    await flush();

    expect(h.client.cancelCapture).toHaveBeenCalledWith(idleIdentity.sessionId, idleIdentity.captureId);
    expect(h.client.beginCapture).toHaveBeenCalledTimes(2);
    expect(h.client.finalizeCapture).not.toHaveBeenCalled();
    expect(h.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining('capture_duration_limit'), 'error');
    expect(h.controller.state).toBe('starting');

    const speechIdentity = h.current();
    h.ready(speechIdentity);
    expect(h.controller.state).toBe('active');
    h.speech(speechIdentity);
    h.durationLimit(speechIdentity);

    expect(h.client.finalizeCapture).toHaveBeenCalledWith(
      speechIdentity.sessionId,
      speechIdentity.captureId,
      'duration-limit',
    );
    expect(h.client.beginCapture).toHaveBeenCalledTimes(2);
    expect(h.controller.state).toBe('active');
  });

  it('queues reactivation until a draining session has fully stopped', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();
    h.speech(identity);

    await h.controller.deactivate(h.ui);
    expect(h.controller.state).toBe('draining');
    let reactivated = false;
    const reactivation = h.controller.activate(h.ui).then(() => {
      reactivated = true;
    });
    await flush();
    expect(reactivated).toBe(false);
    expect(h.client.start).toHaveBeenCalledOnce();

    h.drained(identity, 4);
    h.candidate(identity, 'computer preserve reload handoff', 4, strongEvidence);
    await flush();
    h.acknowledge(identity, 4, 'committed');
    await flush();
    await reactivation;

    expect(h.client.start).toHaveBeenCalledTimes(2);
    expect(h.client.beginCapture).toHaveBeenCalledTimes(2);
    h.ready();
    expect(h.controller.state).toBe('active');
  });

  it('toggles off from silence promptly without finalization or transcription', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();

    await h.controller.toggle(h.ui);
    await flush();

    expect(h.client.finalizeCapture).not.toHaveBeenCalled();
    expect(h.client.cancelCapture).toHaveBeenCalledWith(identity.sessionId, identity.captureId);
    expect(h.client.shutdown).toHaveBeenCalledWith('session-shutdown');
    expect(h.controller.state).toBe('disabled');
  });

  it('finishes one confirmed turn after toggle-off and never starts another capture', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();
    h.speech(identity);

    await h.controller.toggle(h.ui);
    expect(h.client.finalizeCapture).toHaveBeenCalledWith(identity.sessionId, identity.captureId, 'auto-disabled');
    h.drained(identity, 4);
    h.candidate(identity, 'computer finish this request', 4, strongEvidence);
    await flush();
    expect(h.deliver).toHaveBeenCalledWith('finish this request');
    h.acknowledge(identity, 4, 'committed');
    await flush();

    expect(h.client.finalizeCapture).toHaveBeenCalledOnce();
    expect(h.client.beginCapture).toHaveBeenCalledOnce();
    expect(h.controller.state).toBe('disabled');
  });

  it('hard-aborts a hung transcription twenty seconds after toggle-off', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    await h.controller.toggle(h.ui);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.controller.state).toBe('draining');
    expect(h.client.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(h.client.finalizeCapture).toHaveBeenCalledOnce();
    expect(h.client.cancelCapture).toHaveBeenCalledWith(identity.sessionId, identity.captureId);
    expect(h.client.shutdown).toHaveBeenCalledOnce();
    expect(h.ui.notify).toHaveBeenCalledWith('Autonomous voice failed: graceful_stop_timed_out', 'error');
    expect(h.controller.state).toBe('disabled');
  });

  it('forces the lifecycle deadline without duplicating a never-resolving cleanup', async () => {
    const h = harness({ shutdown: () => new Promise<void>(() => undefined) });
    await enable(h);
    const identity = h.current();

    await h.controller.toggle(h.ui);
    await flush();
    expect(h.controller.state).toBe('draining');
    expect(h.client.shutdown).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.controller.state).toBe('draining');
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(h.client.cancelCapture).toHaveBeenCalledWith(identity.sessionId, identity.captureId);
    expect(h.client.shutdown).toHaveBeenCalledOnce();
    expect(h.ui.notify).toHaveBeenCalledWith('Autonomous voice failed: graceful_stop_timed_out', 'error');
    expect(h.controller.state).toBe('disabled');
    expect(h.client.beginCapture).toHaveBeenCalledOnce();
  });

  it('acknowledges empty and command-only stop turns as discarded', async () => {
    const empty = harness();
    await enable(empty);
    const emptyIdentity = empty.current();
    empty.speech(emptyIdentity);
    empty.endpoint(emptyIdentity);
    empty.drained(emptyIdentity, 2);
    empty.emit({
      kind: 'failure',
      code: 'empty_transcript',
      recoverable: true,
      ...emptyIdentity,
      revision: 2,
    });
    await flush();
    expect(empty.client.acknowledgeCandidate).toHaveBeenCalledWith(
      emptyIdentity.sessionId,
      emptyIdentity.turnId,
      2,
      'discarded',
    );
    empty.acknowledge(emptyIdentity, 2, 'discarded');
    await flush();
    expect(empty.client.beginCapture).toHaveBeenCalledTimes(2);

    const stopping = harness();
    await enable(stopping);
    const result = await finishTurn(stopping, 'stop listening', 3);
    expect(result.outcome).toBe('discarded');
    expect(stopping.deliver).not.toHaveBeenCalled();
    stopping.acknowledge(result.identity, 3, 'discarded');
    await flush();
    expect(stopping.controller.state).toBe('disabled');
    expect(stopping.client.beginCapture).toHaveBeenCalledOnce();
  });

  it('retains modal delivery and flushes the exact transcript once when Pi unblocks', async () => {
    const h = harness();
    await enable(h);
    h.controller.askUserBlocked(true);
    const identity = h.current();
    h.speech(identity);
    h.endpoint(identity);
    h.drained(identity, 1);
    h.candidate(identity, 'computer preserve   my words', 1, strongEvidence);
    await flush();

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.client.acknowledgeCandidate).not.toHaveBeenCalled();
    h.controller.askUserBlocked(false);
    await flush();

    expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledWith('preserve my words');
    expect(h.client.acknowledgeCandidate).toHaveBeenCalledWith(identity.sessionId, identity.turnId, 1, 'committed');
  });

  it('gates direct narration playback without letting raw speech cancel TTS', async () => {
    const h = harness();
    await enable(h);
    const narration = h.controller.narrateAgent('Safe spoken update');
    await flush();

    expect(h.tts.speak).toHaveBeenCalledOnce();
    expect(h.client.setPlaybackState).toHaveBeenCalledWith(expect.any(String), 1, true, {
      text: 'Safe spoken update',
      startPhrases: ['computer'],
      stopPhrases: ['stop listening'],
    });
    h.speech();
    await flush();
    expect(h.playbackAborts[0]).not.toHaveBeenCalled();
    expect(h.ui.setIndicator).toHaveBeenLastCalledWith('narrating');

    h.finishPlayback();
    await expect(narration).resolves.toBe('completed');
    await flush();
    expect(h.client.setPlaybackState).toHaveBeenCalledWith(expect.any(String), 1, false, undefined);
  });

  it('lets ranked worker evidence abort narration and authorize overlap promotion', async () => {
    const h = harness();
    await enable(h);
    const interruption = h.current();
    const narration = h.controller.narrateAgent('Safe spoken update');
    await flush();

    h.emit({
      kind: 'barge-in-evidence',
      ...interruption,
      playbackGeneration: 1,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: true,
        residualTokenCount: 4,
        residualRatio: 0.5,
        voicedMs: 800,
        peakDbAboveNoise: 12,
        signalVariationDb: 5,
        narrationSimilarity: 0.2,
      },
    });
    await flush();

    expect(h.client.confirmBargeIn).toHaveBeenCalledWith(
      interruption.sessionId,
      interruption.captureId,
      interruption.turnId,
      1,
      'promote',
    );
    expect(h.playbackAborts[0]).toHaveBeenCalledOnce();
    await expect(narration).resolves.toBe('interrupted');
  });

  it('handles a rejected barge-in playback abort without an unhandled rejection', async () => {
    const h = harness();
    await enable(h);
    const interruption = h.current();
    const narration = h.controller.narrateAgent('Safe spoken update');
    await flush();
    h.playbackAborts[0]?.mockRejectedValueOnce(new Error('abort failed'));

    h.emit({
      kind: 'barge-in-evidence',
      ...interruption,
      playbackGeneration: 1,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: true,
        residualTokenCount: 4,
        residualRatio: 0.5,
        voicedMs: 800,
        peakDbAboveNoise: 12,
        signalVariationDb: 5,
        narrationSimilarity: 0.2,
      },
    });
    await flush();
    expect(h.playbackAborts[0]).toHaveBeenCalledOnce();

    h.finishPlayback();
    await expect(narration).resolves.toBe('completed');
    await flush();
    expect(h.ui.notify).toHaveBeenCalledWith('Autonomous voice playback abort failed: abort failed', 'error');
  });

  it('ignores stale identities and hard-stops after worker exhaustion', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();
    h.emit({ kind: 'endpoint-reached', ...identity, captureId: 'stale-capture' });
    h.emit({
      kind: 'transcript-candidate',
      ...identity,
      turnId: 'stale-turn',
      revision: 1,
      transcript: 'ignored',
      final: true,
    });
    expect(h.client.finalizeCapture).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();

    h.exhaust();
    await flush();
    expect(h.ui.notify).toHaveBeenCalledWith('Autonomous voice failed: worker_heartbeat', 'error');
    expect(h.controller.state).toBe('disabled');
  });

  it('reports delivery failure, discards the revision, and continues after acknowledgement', async () => {
    const h = harness();
    h.deliver.mockImplementationOnce(() => {
      throw new Error('editor unavailable');
    });
    await enable(h);
    const result = await finishTurn(h, 'computer retry me', 1);

    expect(result.outcome).toBe('discarded');
    expect(h.ui.notify).toHaveBeenCalledWith('Autonomous voice failed: editor unavailable', 'error');
    h.acknowledge(result.identity, 1, 'discarded');
    await flush();
    expect(h.client.beginCapture).toHaveBeenCalledTimes(2);
  });

  it('shuts down a worker that finishes starting after activation cancellation', async () => {
    let resolveStart!: () => void;
    const h = harness({
      start: () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    });

    const activation = h.controller.activate(h.ui);
    await flush();
    expect(h.controller.state).toBe('starting');

    await h.controller.deactivate(h.ui);
    await activation;
    expect(h.controller.state).toBe('disabled');
    expect(h.client.shutdown).toHaveBeenCalledOnce();
    expect(h.client.beginCapture).not.toHaveBeenCalled();

    resolveStart();
    await flush();
    expect(h.client.shutdown).toHaveBeenCalledTimes(2);
    expect(h.client.beginCapture).not.toHaveBeenCalled();
  });

  it('shuts down a worker that finishes starting after the startup deadline', async () => {
    let resolveStart!: () => void;
    const h = harness({
      start: () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    });

    const activation = h.controller.activate(h.ui);
    await flush();
    await vi.advanceTimersByTimeAsync(21_000);
    await activation;

    expect(h.controller.state).toBe('disabled');
    expect(h.client.shutdown).toHaveBeenCalledOnce();
    expect(h.client.beginCapture).not.toHaveBeenCalled();

    resolveStart();
    await flush();
    expect(h.client.shutdown).toHaveBeenCalledTimes(2);
    expect(h.client.beginCapture).not.toHaveBeenCalled();
  });

  it('fails safely before capture when manual mode, configuration, or worker startup is unavailable', async () => {
    const manual = harness({ manualState: 'recording' });
    await manual.controller.toggle(manual.ui);
    expect(manual.controller.state).toBe('disabled');
    expect(manual.controller.activationError).toContain('Stop manual');
    expect(manual.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Stop manual'), 'error');

    const missing = harness({ loadedConfig: { ...config, autoCapture: undefined } });
    await missing.controller.toggle(missing.ui);
    expect(missing.controller.state).toBe('disabled');
    expect(missing.controller.activationError).toContain('not configured');
    expect(missing.ui.notify).toHaveBeenCalledWith(expect.stringContaining('not configured'), 'error');

    const unavailable = harness({ start: async () => Promise.reject(new Error('worker unavailable')) });
    await unavailable.controller.toggle(unavailable.ui);
    await flush();
    expect(unavailable.ui.notify).toHaveBeenCalledWith(expect.stringContaining('worker unavailable'), 'error');
    expect(unavailable.controller.activationError).toBe('worker unavailable');
    expect(unavailable.controller.state).toBe('disabled');
  });

  it('hard shutdown cancels capture, playback, and the worker', async () => {
    const h = harness();
    await enable(h);
    const identity = h.current();

    await h.controller.shutdown(h.ui);
    await flush();

    expect(h.client.cancelCapture).toHaveBeenCalledWith(identity.sessionId, identity.captureId);
    expect(h.client.shutdown).toHaveBeenCalledWith('session-shutdown');
    expect(h.controller.state).toBe('disabled');
  });

  it('keeps telemetry open across activations and closes it once on terminal shutdown', async () => {
    const telemetrySink: VoiceWorkerAutoCaptureTelemetrySink = {
      recordEvent: vi.fn(),
      recordError: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const h = harness({ telemetrySink });
    await enable(h);

    await h.controller.toggle(h.ui);
    await flush();
    expect(h.controller.state).toBe('disabled');
    expect(telemetrySink.shutdown).not.toHaveBeenCalled();

    await enable(h);
    expect(telemetrySink.recordEvent).toHaveBeenCalledWith(
      'doom_voice.autonomous_transition',
      expect.objectContaining({ from_state: 'off', to_state: 'enabling' }),
    );

    await h.controller.shutdown(h.ui);
    await h.controller.shutdown(h.ui);
    expect(telemetrySink.shutdown).toHaveBeenCalledOnce();

    const startsBeforeDisposedToggle = vi.mocked(h.client.start).mock.calls.length;
    await h.controller.toggle(h.ui);
    expect(h.client.start).toHaveBeenCalledTimes(startsBeforeDisposedToggle);
    expect(h.ui.notify).toHaveBeenLastCalledWith('Autonomous voice has been shut down', 'error');
  });
});
