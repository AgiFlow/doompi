import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { describe, expect, it, vi } from 'vitest';
import { VoiceNarrationPlayback } from '../src/services/narrationPlayback.ts';
import type {
  IClock,
  ITtsAdapter,
  TtsPlaybackOutcome,
  TtsPlaybackResult,
  TtsSpeakRequest,
} from '../src/types/index.ts';

const config: ResolvedVoiceConfig = {
  engine: 'mlx-whisper',
  language: 'auto',
  recorder: { device: 'none:default' },
  adapters: { 'mlx-whisper': { model: { id: 'local-model' } } },
  autoCapture: {
    model: 'provider/model',
    startPhrases: [],
    stopPhrases: [],
    utteranceIdleMs: 3_000,
    composeOpenPhrases: ['hey doom'],
    composeSendPhrases: ["that's it"],
    composeCancelPhrases: ['doom cancel'],
    composeUtteranceIdleMs: 1_200,
    composeNudgeMs: 10_000,
    transcriptionTimeoutMs: 15_000,
    tts: { engine: 'macos-say' },
  },
};

interface PlaybackControl {
  readonly request: TtsSpeakRequest;
  readonly abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  settle(outcome?: TtsPlaybackOutcome): void;
  fail(error: unknown): void;
}

function fixture() {
  let now = 100;
  const playbacks: PlaybackControl[] = [];
  const speak = vi.fn((request: TtsSpeakRequest) => {
    let settled = false;
    let resolve!: (result: TtsPlaybackResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<TtsPlaybackResult>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const settle = (outcome: TtsPlaybackOutcome = 'completed'): void => {
      if (settled) return;
      settled = true;
      resolve({
        outcome,
        reference: { ...request, startedAt: now, endedAt: now + 1 },
        process: { code: outcome === 'completed' ? 0 : 1, stdout: '', stderr: '' },
      });
    };
    const control: PlaybackControl = {
      request,
      abort: vi.fn(async () => settle('aborted')),
      settle,
      fail(error: unknown) {
        if (settled) return;
        settled = true;
        reject(error);
      },
    };
    playbacks.push(control);
    return {
      reference: { ...request, startedAt: now },
      completion,
      stop: vi.fn(async () => settle('stopped')),
      abort: control.abort,
    };
  });
  const tts: ITtsAdapter = { preflight: vi.fn(), speak };
  const clock: IClock = {
    now: () => now,
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clear: (handle) => clearTimeout(handle),
  };
  const logger = { recordError: vi.fn() };
  const notify = vi.fn();
  const onPlaybackStarted = vi.fn();
  const onPlaybackEnded = vi.fn();
  const playback = new VoiceNarrationPlayback({
    tts,
    clock,
    logger,
    notify,
    onPlaybackStarted,
    onPlaybackEnded,
  });
  return {
    playback,
    playbacks,
    speak,
    logger,
    notify,
    onPlaybackStarted,
    onPlaybackEnded,
    setNow(value: number) {
      now = value;
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('VoiceNarrationPlayback', () => {
  it('speaks exact direct wording at final priority and awaits physical completion', async () => {
    const h = fixture();
    await expect(h.playback.narrate('Inactive.', 'final')).resolves.toBe('interrupted');
    h.playback.activate(config);

    const narration = h.playback.narrate('Exact primary-agent wording.', 'final');
    let settled = false;
    void narration.then(() => {
      settled = true;
    });
    await flush();

    expect(settled).toBe(false);
    expect(h.playbacks[0]?.request).toMatchObject({ kind: 'final', text: 'Exact primary-agent wording.' });
    expect(h.onPlaybackStarted).toHaveBeenCalledWith(1, 'Exact primary-agent wording.');
    expect(h.playback.references()).toEqual(['Exact primary-agent wording.']);

    h.playbacks[0]?.settle();
    await expect(narration).resolves.toBe('completed');
    expect(h.onPlaybackEnded).toHaveBeenCalledWith(1);
    expect(h.playback.references()).toEqual(['Exact primary-agent wording.']);

    h.setNow(60_102);
    expect(h.playback.references()).toEqual([]);
    await h.playback.deactivate();
  });

  it('never interrupts active autonomous narration and preserves FIFO without a compactor', async () => {
    const h = fixture();
    h.playback.activate(config);

    const direct = h.playback.narrate('Direct update.', 'final');
    const external = h.playback.narrate('External handoff.', 'clarification');
    const latest = h.playback.narrate('Latest update.', 'final');

    expect(h.playbacks[0]?.abort).not.toHaveBeenCalled();
    expect(h.playbacks).toHaveLength(1);
    h.playbacks[0]?.settle();
    await expect(direct).resolves.toBe('completed');
    expect(h.playbacks[1]?.request.text).toBe('External handoff.');

    h.playbacks[1]?.settle();
    await expect(external).resolves.toBe('completed');
    expect(h.playbacks[2]?.request.text).toBe('Latest update.');
    h.playbacks[2]?.settle();
    await expect(latest).resolves.toBe('completed');
  });

  it('defers new playback, compacts queued requests, and releases one summary when the turn is delivered', async () => {
    const h = fixture();
    const compact = vi.fn(async () => 'One concise queued summary.');
    h.playback.activate(config, { compact });
    h.playback.setDeferred(true);

    const first = h.playback.narrate('First queued update.', 'final');
    const second = h.playback.narrate('Second queued warning.', 'clarification');
    await flush();

    expect(h.speak).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith(['First queued update.', 'Second queued warning.'], expect.any(AbortSignal));

    h.playback.setDeferred(false);
    await flush();
    expect(h.playbacks).toHaveLength(1);
    expect(h.playbacks[0]?.request).toMatchObject({ kind: 'clarification', text: 'One concise queued summary.' });

    h.playbacks[0]?.settle();
    await expect(Promise.all([first, second])).resolves.toEqual(['completed', 'completed']);
  });

  it('does not interrupt active playback when narration becomes deferred', async () => {
    const h = fixture();
    h.playback.activate(config);
    const active = h.playback.narrate('Already speaking.', 'final');

    h.playback.setDeferred(true);
    const queued = h.playback.narrate('Wait until delivery.', 'final');
    h.playbacks[0]?.settle();
    await expect(active).resolves.toBe('completed');
    expect(h.playbacks).toHaveLength(1);

    h.playback.setDeferred(false);
    expect(h.playbacks[1]?.request.text).toBe('Wait until delivery.');
    h.playbacks[1]?.settle();
    await expect(queued).resolves.toBe('completed');
  });

  it('compacts two pending requests and settles represented callers after summary playback', async () => {
    const h = fixture();
    let finishCompaction!: (summary: string) => void;
    const compact = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishCompaction = resolve;
        }),
    );
    h.playback.activate(config, { compact });

    const active = h.playback.narrate('Active update.', 'final');
    const first = h.playback.narrate('First pending update.', 'final');
    expect(compact).not.toHaveBeenCalled();
    const second = h.playback.narrate('Second pending warning.', 'clarification');
    await flush();

    expect(compact).toHaveBeenCalledWith(['First pending update.', 'Second pending warning.'], expect.any(AbortSignal));
    expect(h.playbacks[0]?.abort).not.toHaveBeenCalled();
    finishCompaction('Pending update and warning.');
    await flush();
    h.playbacks[0]?.settle();
    await expect(active).resolves.toBe('completed');
    expect(h.playbacks[1]?.request).toMatchObject({ kind: 'clarification', text: 'Pending update and warning.' });

    let representedSettled = false;
    void Promise.all([first, second]).then(() => {
      representedSettled = true;
    });
    await flush();
    expect(representedSettled).toBe(false);
    h.playbacks[1]?.settle();
    await expect(Promise.all([first, second])).resolves.toEqual(['completed', 'completed']);
  });

  it('folds arrivals during compaction into the pending summary', async () => {
    const h = fixture();
    const completions: Array<(summary: string) => void> = [];
    const compact = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          completions.push(resolve);
        }),
    );
    h.playback.activate(config, { compact });

    const active = h.playback.narrate('Active.', 'final');
    const first = h.playback.narrate('First.', 'final');
    const second = h.playback.narrate('Second.', 'final');
    const later = h.playback.narrate('Later.', 'final');
    await flush();
    completions[0]?.('First and second.');
    await flush();

    expect(compact).toHaveBeenNthCalledWith(2, ['First and second.', 'Later.'], expect.any(AbortSignal));
    completions[1]?.('All pending updates.');
    await flush();
    h.playbacks[0]?.settle();
    await active;
    expect(h.playbacks[1]?.request.text).toBe('All pending updates.');
    h.playbacks[1]?.settle();
    await expect(Promise.all([first, second, later])).resolves.toEqual(['completed', 'completed', 'completed']);
  });

  it('falls back to one bounded deterministic utterance when model compaction fails', async () => {
    const h = fixture();
    const compact = vi.fn(async () => {
      throw new Error('summary unavailable');
    });
    h.playback.activate(config, { compact });

    const active = h.playback.narrate('Active.', 'final');
    const first = h.playback.narrate('First exact pending.', 'final');
    const second = h.playback.narrate('Second exact pending.', 'clarification');
    await flush();
    h.playbacks[0]?.settle();
    await active;
    expect(h.playbacks[1]?.request).toMatchObject({
      kind: 'clarification',
      text: 'First exact pending. Second exact pending.',
    });
    h.playbacks[1]?.settle();
    await expect(Promise.all([first, second])).resolves.toEqual(['completed', 'completed']);
    expect(h.playbacks).toHaveLength(2);
    expect(h.logger.recordError).toHaveBeenCalledWith('doom_voice.narration_compaction_failed', expect.any(Error));
  });

  it('strictly bounds deterministic compaction while representing each queued request', async () => {
    const h = fixture();
    h.playback.activate(config, {
      compact: vi.fn(async () => {
        throw new Error('summary unavailable');
      }),
    });
    const active = h.playback.narrate('Active.', 'final');
    const first = h.playback.narrate(`First ${'a'.repeat(1_000)}`, 'final');
    const second = h.playback.narrate(`Second ${'b'.repeat(1_000)}`, 'final');
    await flush();

    h.playbacks[0]?.settle();
    await active;
    const fallback = h.playbacks[1]?.request.text ?? '';
    expect(Array.from(fallback).length).toBeLessThanOrEqual(640);
    expect(fallback).toContain('First ');
    expect(fallback).toContain('Second ');
    h.playbacks[1]?.settle();
    await Promise.all([first, second]);
  });

  it('maps caller cancellation and deactivation to interrupted', async () => {
    const h = fixture();
    h.playback.activate(config);
    const controller = new AbortController();
    const cancelled = h.playback.narrate('Cancel me.', 'final', controller.signal);

    controller.abort(new Error('tool cancelled'));
    await expect(cancelled).resolves.toBe('interrupted');
    expect(h.playbacks[0]?.abort).toHaveBeenCalledOnce();

    const active = h.playback.narrate('Stop activation.', 'final');
    const deactivated = h.playback.deactivate();
    await expect(active).resolves.toBe('interrupted');
    await deactivated;
    expect(h.playback.references()).toEqual([]);
  });

  it('settles one cancelled represented caller without cancelling the shared summary', async () => {
    const h = fixture();
    const compact = vi.fn(async () => 'Shared pending summary.');
    h.playback.activate(config, { compact });
    const active = h.playback.narrate('Active.', 'final');
    const cancellation = new AbortController();
    const cancelled = h.playback.narrate('Cancelled pending.', 'final', cancellation.signal);
    const retained = h.playback.narrate('Retained pending.', 'final');
    await flush();

    cancellation.abort(new Error('caller stopped waiting'));
    await expect(cancelled).resolves.toBe('interrupted');
    h.playbacks[0]?.settle();
    await active;
    expect(h.playbacks[1]?.request.text).toBe('Shared pending summary.');
    expect(h.playbacks[1]?.abort).not.toHaveBeenCalled();
    h.playbacks[1]?.settle();
    await expect(retained).resolves.toBe('completed');
  });

  it('aborts compaction and settles all queued callers during cleanup', async () => {
    const h = fixture();
    let compactionSignal: AbortSignal | undefined;
    const compact = vi.fn(
      (_narrations: readonly string[], signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          compactionSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    h.playback.activate(config, { compact });
    const active = h.playback.narrate('Active.', 'final');
    const first = h.playback.narrate('First pending.', 'final');
    const second = h.playback.narrate('Second pending.', 'final');
    await flush();

    const cleanup = h.playback.deactivate();
    await expect(Promise.all([active, first, second])).resolves.toEqual(['interrupted', 'interrupted', 'interrupted']);
    await cleanup;
    expect(compactionSignal?.aborted).toBe(true);
    expect(h.playbacks[0]?.abort).toHaveBeenCalledOnce();
    expect(h.playbacks).toHaveLength(1);
  });

  it('bounds retained narration references to the latest sixteen utterances', async () => {
    const h = fixture();
    h.playback.activate(config);

    for (let index = 0; index < 18; index += 1) {
      const narration = h.playback.narrate(`Update ${index}.`, 'final');
      h.playbacks[index]?.settle();
      await narration;
    }

    expect(h.playback.references()).toHaveLength(16);
    expect(h.playback.references()[0]).toBe('Update 2.');
    expect(h.playback.references().at(-1)).toBe('Update 17.');
    await h.playback.deactivate();
  });

  it('rejects empty speech and configurations without autonomous playback', async () => {
    const h = fixture();
    h.playback.activate(config);
    await expect(h.playback.narrate('   ', 'final')).resolves.toBe('failed');
    await h.playback.deactivate();

    const withoutAutoCapture = { ...config, autoCapture: undefined } as unknown as ResolvedVoiceConfig;
    h.playback.activate(withoutAutoCapture);
    await expect(h.playback.narrate('Unavailable.', 'final')).resolves.toBe('failed');
    expect(h.speak).not.toHaveBeenCalled();
    await h.playback.deactivate();
  });

  it('does not retain rejected physical playback as narration echo history', async () => {
    const h = fixture();
    h.playback.activate(config);
    const failed = h.playback.narrate('Never became audible.', 'final');
    h.playbacks[0]?.fail(new Error('speaker failed before playback'));

    await expect(failed).resolves.toBe('failed');
    expect(h.playback.references()).toEqual([]);
    await h.playback.deactivate();
  });

  it('isolates playback failure and disables narration only for the current activation', async () => {
    const h = fixture();
    h.playback.activate(config);
    const failed = h.playback.narrate('Unavailable.', 'final');
    const queued = h.playback.narrate('Must not play.', 'final');
    h.playbacks[0]?.settle('failed');

    await expect(failed).resolves.toBe('failed');
    await expect(queued).resolves.toBe('failed');
    expect(h.playback.references()).toEqual([]);
    expect(h.logger.recordError).toHaveBeenCalledWith(
      'doom_voice.narration_playback_failed',
      expect.any(Error),
      expect.objectContaining({ 'narration.kind': 'final' }),
    );
    expect(h.notify).toHaveBeenCalledOnce();
    await expect(h.playback.narrate('Still disabled.', 'final')).resolves.toBe('failed');
    expect(h.speak).toHaveBeenCalledOnce();

    await h.playback.deactivate();
    h.playback.activate(config);
    const recovered = h.playback.narrate('Recovered.', 'final');
    h.playbacks[1]?.settle();
    await expect(recovered).resolves.toBe('completed');
  });
});
