import { describe, expect, it, vi } from 'vitest';
import {
  type BinaryProcessStartOptions,
  type BinaryRunningProcess,
  type IClock,
  type ITtsAdapter,
  MacOsSayTtsAdapter,
  NarrationPlaybackCoordinator,
  type ProcessResult,
  type TimerHandle,
  type TtsPlayback,
  type TtsSpeakRequest,
} from '../src/exports';

class DeferredBinaryProcess implements BinaryRunningProcess {
  readonly signals: NodeJS.Signals[] = [];
  readonly writes: (string | Buffer)[] = [];
  closedStdin = false;
  readonly completion: Promise<ProcessResult>;
  private resolveCompletion!: (result: ProcessResult) => void;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  onStdout(): () => void {
    return () => undefined;
  }

  writeStdin(data: string | Buffer): boolean {
    this.writes.push(data);
    return true;
  }

  closeStdin(): void {
    this.closedStdin = true;
  }

  signal(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  finish(result: ProcessResult = { code: 0, stdout: '', stderr: '' }): void {
    this.resolveCompletion(result);
  }
}

function controlledClock(): { clock: IClock; callbacks: (() => void)[]; advance: (milliseconds: number) => void } {
  const callbacks: (() => void)[] = [];
  let now = 100;
  return {
    callbacks,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    clock: {
      now: () => now,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return { index: callbacks.length - 1 } as unknown as TimerHandle;
      },
      clear: vi.fn(),
    },
  };
}

describe('macOS say TTS adapter', () => {
  it('uses the fixed executable, validated argv, and private stdin text', async () => {
    const processHandle = new DeferredBinaryProcess();
    const started: {
      executable?: string;
      args?: readonly string[];
      options?: BinaryProcessStartOptions;
    } = {};
    const { clock, advance } = controlledClock();
    const resolver = { resolve: vi.fn(() => '/usr/bin/say') };
    const adapter = new MacOsSayTtsAdapter(
      resolver,
      {
        start: (executable, args, options) => {
          started.executable = executable;
          started.args = args;
          started.options = options;
          return processHandle;
        },
      },
      clock,
    );

    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      adapter.preflight({ engine: 'macos-say', voice: 'Samantha', rate: 190 });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    const playback = adapter.speak({
      id: 7,
      kind: 'final',
      text: 'A private spoken summary.',
      config: { engine: 'macos-say', voice: 'Samantha', rate: 190 },
    });
    advance(250);
    processHandle.finish();
    const result = await playback.completion;

    expect(resolver.resolve).toHaveBeenCalledWith('/usr/bin/say', 'say');
    expect(started).toEqual({
      executable: '/usr/bin/say',
      args: ['-v', 'Samantha', '-r', '190'],
      options: { stdin: 'pipe' },
    });
    expect(started.args).not.toContain('A private spoken summary.');
    expect(processHandle.writes).toEqual(['A private spoken summary.']);
    expect(processHandle.closedStdin).toBe(true);
    expect(result).toMatchObject({
      outcome: 'completed',
      reference: { id: 7, kind: 'final', text: 'A private spoken summary.', startedAt: 100, endedAt: 350 },
    });
  });

  it('stops with bounded escalation and aborts immediately', async () => {
    const firstProcess = new DeferredBinaryProcess();
    const secondProcess = new DeferredBinaryProcess();
    const processes = [firstProcess, secondProcess];
    const { clock, callbacks } = controlledClock();
    const adapter = new MacOsSayTtsAdapter(
      { resolve: () => '/usr/bin/say' },
      { start: () => processes.shift()! },
      clock,
    );

    const stopped = adapter.speak({
      id: 1,
      kind: 'clarification',
      text: 'Clarification.',
      config: { engine: 'macos-say' },
    });
    const stopping = stopped.stop();
    callbacks[0]?.();
    callbacks[1]?.();
    firstProcess.finish({ code: 1, stdout: '', stderr: '' });
    await stopping;
    expect(firstProcess.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect((await stopped.completion).outcome).toBe('stopped');

    const aborted = adapter.speak({
      id: 2,
      kind: 'final',
      text: 'Final.',
      config: { engine: 'macos-say' },
    });
    const aborting = aborted.abort();
    secondProcess.finish({ code: 1, stdout: '', stderr: '' });
    await aborting;
    expect(secondProcess.signals).toEqual(['SIGKILL']);
    expect((await aborted.completion).outcome).toBe('aborted');
  });
});

class FakePlayback implements TtsPlayback {
  readonly completion: Promise<Awaited<TtsPlayback['completion']>>;
  readonly abort = vi.fn(async () => {
    this.finish('aborted');
  });
  readonly stop = vi.fn(async () => {
    this.finish('stopped');
  });
  private resolveCompletion!: (result: Awaited<TtsPlayback['completion']>) => void;

  constructor(readonly reference: TtsPlayback['reference']) {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  finish(outcome: Awaited<TtsPlayback['completion']>['outcome'] = 'completed'): void {
    this.resolveCompletion({
      outcome,
      reference: { ...this.reference, endedAt: this.reference.startedAt + 1 },
      process: { code: outcome === 'completed' ? 0 : 1, stdout: '', stderr: '' },
    });
  }
}

class RejectablePlayback implements TtsPlayback {
  readonly completion: Promise<Awaited<TtsPlayback['completion']>>;
  readonly stop = vi.fn(async () => undefined);
  readonly abort = vi.fn(async () => undefined);
  private rejectCompletion!: (error: unknown) => void;

  constructor(readonly reference: TtsPlayback['reference']) {
    this.completion = new Promise((_resolve, reject) => {
      this.rejectCompletion = reject;
    });
  }

  fail(error: unknown): void {
    this.rejectCompletion(error);
  }
}

class FakeTtsAdapter implements ITtsAdapter {
  readonly requests: TtsSpeakRequest[] = [];
  readonly playbacks: FakePlayback[] = [];

  preflight(): void {}

  speak(request: TtsSpeakRequest): TtsPlayback {
    this.requests.push(request);
    const playback = new FakePlayback({
      id: request.id,
      kind: request.kind,
      text: request.text,
      startedAt: request.id,
    });
    this.playbacks.push(playback);
    return playback;
  }
}

describe('narration playback coordination', () => {
  it('emits exactly-once physical lifecycle events in playback order', async () => {
    const adapter = new FakeTtsAdapter();
    const events: string[] = [];
    const coordinator = new NarrationPlaybackCoordinator(
      adapter,
      (event) => {
        events.push(`${event.kind}:${event.reference.text}`);
      },
      vi.fn(),
    );
    const config = { engine: 'macos-say' as const };

    const first = coordinator.enqueue({ kind: 'final', text: 'First.', config });
    const second = coordinator.enqueue({ kind: 'final', text: 'Second.', config });
    adapter.playbacks[0]?.finish();
    await first;
    adapter.playbacks[1]?.finish();
    await second;

    expect(events).toEqual(['started:First.', 'settled:First.', 'started:Second.', 'settled:Second.']);
  });

  it('emits no lifecycle event for a replaced pending request and isolates observer errors', async () => {
    const adapter = new FakeTtsAdapter();
    const observed: string[] = [];
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const observeError = vi.fn(() => {
      throw new Error('observer error reporting unavailable');
    });
    const coordinator = new NarrationPlaybackCoordinator(
      adapter,
      (event) => {
        observed.push(`${event.kind}:${event.reference.text}`);
        throw new Error('observer unavailable');
      },
      observeError,
    );
    const config = { engine: 'macos-say' as const };

    const active = coordinator.enqueue({ kind: 'clarification', text: 'Active.', config });
    const replaced = coordinator.enqueue({ kind: 'clarification', text: 'Replaced.', config });
    const latest = coordinator.enqueue({ kind: 'clarification', text: 'Latest.', config });
    await expect(replaced).resolves.toMatchObject({ outcome: 'superseded' });
    adapter.playbacks[0]?.finish();
    await active;
    adapter.playbacks[1]?.finish();
    await latest;

    expect(observed).toEqual(['started:Active.', 'settled:Active.', 'started:Latest.', 'settled:Latest.']);
    expect(observeError).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenCalledTimes(4);
  });

  it('keeps one active and one latest pending clarification', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };

    const first = coordinator.enqueue({ kind: 'clarification', text: 'First.', config });
    const replaced = coordinator.enqueue({ kind: 'clarification', text: 'Second.', config });
    const latest = coordinator.enqueue({ kind: 'clarification', text: 'Latest.', config });

    expect(await replaced).toMatchObject({ outcome: 'superseded' });
    expect(adapter.requests.map((request) => request.text)).toEqual(['First.']);
    adapter.playbacks[0]?.finish();
    await first;
    expect(adapter.requests.map((request) => request.text)).toEqual(['First.', 'Latest.']);
    adapter.playbacks[1]?.finish();
    await latest;
  });

  it('lets clarification replace pending final and abort lower-priority final narration', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };

    const final = coordinator.enqueue({ kind: 'final', text: 'Final.', config });
    const pendingPlan = coordinator.enqueue({ kind: 'plan', text: 'Stale plan.', config });
    const clarification = coordinator.enqueue({ kind: 'clarification', text: 'Clarification.', config });

    expect(await pendingPlan).toMatchObject({ outcome: 'superseded' });
    expect(adapter.playbacks[0]?.abort).toHaveBeenCalledOnce();
    await final;
    expect(adapter.requests.map((request) => request.text)).toEqual(['Final.', 'Clarification.']);
    adapter.playbacks[1]?.finish();
    await clarification;
    expect(coordinator.activeReference).toBeUndefined();
  });

  it('retains the physical playback barrier when interruption fails', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };

    const final = coordinator.enqueue({ kind: 'final', text: 'Final.', config });
    adapter.playbacks[0]?.abort.mockRejectedValueOnce(new Error('abort failed'));
    const clarification = coordinator.enqueue({ kind: 'clarification', text: 'Clarification.', config });
    await Promise.resolve();

    expect(adapter.requests.map((request) => request.text)).toEqual(['Final.']);
    expect(coordinator.activeReference?.text).toBe('Final.');

    adapter.playbacks[0]?.finish();
    await expect(final).resolves.toMatchObject({ outcome: 'completed' });
    expect(adapter.requests.map((request) => request.text)).toEqual(['Final.', 'Clarification.']);
    adapter.playbacks[1]?.finish();
    await expect(clarification).resolves.toMatchObject({ outcome: 'completed' });
  });

  it('settles pre-aborted, pending-aborted, and active-aborted requests exactly once', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      coordinator.enqueue({ kind: 'final', text: 'Never starts.', config }, preAborted.signal),
    ).resolves.toMatchObject({ outcome: 'interrupted' });
    expect(adapter.requests).toEqual([]);

    const activeSignal = new AbortController();
    const pendingSignal = new AbortController();
    const active = coordinator.enqueue({ kind: 'clarification', text: 'Active.', config }, activeSignal.signal);
    const pending = coordinator.enqueue({ kind: 'final', text: 'Pending.', config }, pendingSignal.signal);
    pendingSignal.abort();
    await expect(pending).resolves.toMatchObject({ outcome: 'interrupted' });

    activeSignal.abort();
    await expect(active).resolves.toMatchObject({ outcome: 'interrupted' });
    expect(adapter.playbacks[0]?.abort).toHaveBeenCalledOnce();
  });

  it('aborts active and pending narration during shutdown', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };

    const active = coordinator.enqueue({ kind: 'clarification', text: 'Active.', config });
    const pending = coordinator.enqueue({ kind: 'clarification', text: 'Pending.', config });
    await coordinator.abortAll();

    expect(await pending).toMatchObject({ outcome: 'interrupted' });
    expect(adapter.playbacks[0]?.abort).toHaveBeenCalledOnce();
    expect((await active).outcome).toBe('interrupted');
    expect(coordinator.activeReference).toBeUndefined();
  });

  it('enforces question, clarification, final, plan, and intent priority with one latest pending job', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };
    const intent = coordinator.enqueue({ kind: 'intent', text: 'Intent.', config });
    const plan = coordinator.enqueue({ kind: 'plan', text: 'Plan.', config });
    const final = coordinator.enqueue({ kind: 'final', text: 'Final.', config });
    const clarification = coordinator.enqueue({ kind: 'clarification', text: 'Clarification.', config });
    const question = coordinator.enqueue({ kind: 'question', text: 'Question.', config });

    expect(await plan).toMatchObject({ outcome: 'superseded' });
    expect(await final).toMatchObject({ outcome: 'superseded' });
    expect(await clarification).toMatchObject({ outcome: 'superseded' });
    expect(adapter.playbacks[0]?.abort).toHaveBeenCalled();
    await intent;
    expect(adapter.requests.map(({ text }) => text)).toEqual(['Intent.', 'Question.']);
    adapter.playbacks[1]?.finish();
    await question;
  });

  it('rejects a lower-priority arrival without replacing the latest pending request', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };
    const active = coordinator.enqueue({ kind: 'question', text: 'Question.', config });
    const pending = coordinator.enqueue({ kind: 'final', text: 'Final.', config });
    const lower = coordinator.enqueue({ kind: 'plan', text: 'Plan.', config });

    await expect(lower).resolves.toMatchObject({ outcome: 'superseded' });
    adapter.playbacks[0]?.finish();
    await active;
    expect(adapter.requests.map(({ text }) => text)).toEqual(['Question.', 'Final.']);
    adapter.playbacks[1]?.finish();
    await pending;
  });

  it('leaves narration at or above the requested cancellation priority running', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };
    const active = coordinator.enqueue({ kind: 'question', text: 'Active.', config });
    const pending = coordinator.enqueue({ kind: 'clarification', text: 'Pending.', config });

    await coordinator.cancelBelow('clarification');
    expect(adapter.playbacks[0]?.abort).not.toHaveBeenCalled();
    adapter.playbacks[0]?.finish();
    await active;
    adapter.playbacks[1]?.finish();
    await pending;
  });

  it('cancels only narration below a requested priority', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };
    const intent = coordinator.enqueue({ kind: 'intent', text: 'Intent.', config });
    const plan = coordinator.enqueue({ kind: 'plan', text: 'Plan.', config });

    await coordinator.cancelBelow('final');

    expect(await plan).toMatchObject({ outcome: 'interrupted' });
    expect(adapter.playbacks[0]?.abort).toHaveBeenCalledOnce();
    expect((await intent).outcome).toBe('interrupted');
  });

  it('settles a request as failed when the adapter throws before playback starts', async () => {
    const adapter: ITtsAdapter = {
      preflight: () => undefined,
      speak: () => {
        throw new Error('speaker unavailable');
      },
    };
    const coordinator = new NarrationPlaybackCoordinator(adapter);

    await expect(
      coordinator.enqueue({ kind: 'final', text: 'Answer.', config: { engine: 'macos-say' } }),
    ).resolves.toMatchObject({ outcome: 'failed', error: expect.any(Error) });
    expect(coordinator.activeReference).toBeUndefined();
    await coordinator.abortAll();
  });

  it('fails queued narration without starting it after playback rejects', async () => {
    const playbacks: RejectablePlayback[] = [];
    const adapter: ITtsAdapter = {
      preflight: () => undefined,
      speak: (request) => {
        const playback = new RejectablePlayback({
          id: request.id,
          kind: request.kind,
          text: request.text,
          startedAt: request.id,
        });
        playbacks.push(playback);
        return playback;
      },
    };
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const failed = coordinator.enqueue({ kind: 'clarification', text: 'Failed.', config: { engine: 'macos-say' } });
    const pending = coordinator.enqueue({ kind: 'final', text: 'Must not play.', config: { engine: 'macos-say' } });

    playbacks[0]?.fail(new Error('playback failed'));

    await expect(failed).resolves.toMatchObject({ outcome: 'failed', error: expect.any(Error) });
    await expect(pending).resolves.toMatchObject({ outcome: 'failed', error: expect.any(Error) });
    expect(playbacks).toHaveLength(1);
    expect(coordinator.activeReference).toBeUndefined();
  });

  it('fails queued narration without starting it after a failed process result', async () => {
    const adapter = new FakeTtsAdapter();
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const config = { engine: 'macos-say' as const };
    const failed = coordinator.enqueue({ kind: 'clarification', text: 'Failed.', config });
    const pending = coordinator.enqueue({ kind: 'final', text: 'Must not play.', config });

    adapter.playbacks[0]?.finish('failed');

    await expect(failed).resolves.toMatchObject({ outcome: 'failed' });
    await expect(pending).resolves.toMatchObject({ outcome: 'failed', error: expect.any(Error) });
    expect(adapter.requests.map(({ text }) => text)).toEqual(['Failed.']);
    expect(coordinator.activeReference).toBeUndefined();
  });

  it('propagates abort failure only after physical playback settles', async () => {
    const playback = new RejectablePlayback({
      id: 1,
      kind: 'final',
      text: 'Answer.',
      startedAt: 1,
    });
    playback.abort.mockRejectedValue(new Error('abort failed'));
    const adapter: ITtsAdapter = { preflight: () => undefined, speak: () => playback };
    const coordinator = new NarrationPlaybackCoordinator(adapter);
    const active = coordinator.enqueue({ kind: 'final', text: 'Answer.', config: { engine: 'macos-say' } });
    let activeSettled = false;
    void active.then(() => {
      activeSettled = true;
    });
    const abortAssertion = expect(coordinator.abortAll()).rejects.toThrow('abort failed');
    await Promise.resolve();

    expect(activeSettled).toBe(false);
    expect(coordinator.activeReference?.text).toBe('Answer.');

    playback.fail(new Error('playback failed'));
    await abortAssertion;
    await expect(active).resolves.toMatchObject({ outcome: 'failed', error: expect.any(Error) });
    expect(coordinator.activeReference).toBeUndefined();
  });
});
