import { describe, expect, it, vi } from 'vitest';
import { BoundedTranscriptionQueue, UtteranceAssembler } from '../src/services/utterance.ts';
import type { IClock, TimerHandle } from '../src/types/index.ts';

function controlledClock() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;
  const clock: IClock = {
    now: () => now,
    setInterval: () => ({}) as TimerHandle,
    setTimeout: (callback, milliseconds) => {
      const id = nextId++;
      timers.set(id, { at: now + milliseconds, callback });
      return id as unknown as TimerHandle;
    },
    clear: (handle) => timers.delete(handle as unknown as number),
  };
  return {
    clock,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

describe('utterance assembly', () => {
  it('measures idle from the last voiced frame rather than acoustic close', () => {
    const controlled = controlledClock();
    const onIdle = vi.fn();
    const assembler = new UtteranceAssembler(controlled.clock, 3_000, onIdle);

    controlled.advance(1_000);
    expect(assembler.append(1_000, 600, 1_000)).toBe(true);
    controlled.advance(2_399);
    expect(onIdle).not.toHaveBeenCalled();
    controlled.advance(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('suspends idle when provisional onset begins before the deadline', () => {
    const controlled = controlledClock();
    const onIdle = vi.fn();
    const assembler = new UtteranceAssembler(controlled.clock, 3_000, onIdle);
    assembler.append(600, 600, 600);

    controlled.advance(2_999);
    assembler.provisionalStarted(controlled.clock.now());
    controlled.advance(500);
    expect(onIdle).not.toHaveBeenCalled();
    assembler.append(controlled.clock.now() + 600, 600, 1_000);
    controlled.advance(3_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('finalizes when a suspended provisional candidate collapses after idle', () => {
    const controlled = controlledClock();
    const onIdle = vi.fn();
    const assembler = new UtteranceAssembler(controlled.clock, 3_000, onIdle);
    assembler.append(600, 600, 600);
    controlled.advance(2_999);
    assembler.provisionalStarted(controlled.clock.now());
    controlled.advance(200);

    assembler.provisionalEnded();

    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('rejects segment and PCM limits atomically', () => {
    const controlled = controlledClock();
    const assembler = new UtteranceAssembler(controlled.clock, 3_000, vi.fn(), {
      maximumSegments: 2,
      maximumPcmMs: 1_500,
    });

    expect(assembler.append(600, 600, 700)).toBe(true);
    expect(assembler.append(1_200, 600, 700)).toBe(true);
    expect(assembler.append(1_800, 600, 100)).toBe(false);
    expect(assembler.state).toMatchObject({ segmentCount: 2, pcmMs: 1_400 });
  });
});

describe('bounded transcription queue', () => {
  it('bounds concurrency and preserves caller-selected transcript order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const queue = new BoundedTranscriptionQueue(2, 3);
    const results = [
      queue.schedule(() => first.promise),
      queue.schedule(() => second.promise),
      queue.schedule(() => third.promise),
    ];

    expect(queue.activeCount).toBe(2);
    second.resolve('second');
    await Promise.resolve();
    expect(queue.activeCount).toBe(2);
    third.resolve('third');
    first.resolve('first');

    await expect(Promise.all(results)).resolves.toEqual(['first', 'second', 'third']);
  });

  it('rejects pressure and cancels work that has not started', async () => {
    const active = deferred<string>();
    const queue = new BoundedTranscriptionQueue(1, 2);
    const first = queue.schedule(() => active.promise);
    const queued = queue.schedule(async () => 'queued');

    await expect(queue.schedule(async () => 'overflow')).rejects.toThrow('full');
    queue.cancelQueued();
    await expect(queued).rejects.toThrow('cancelled');
    active.resolve('done');
    await expect(first).resolves.toBe('done');
  });
});
