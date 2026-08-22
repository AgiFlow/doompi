import { describe, expect, it, vi } from 'vitest';
import { QuestionnaireCoordinator, type QuestionnaireRunContext } from '../../src/services/questionnaireCoordinator.js';
import type { QuestionnaireResult } from '../../src/types/questionnaire.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function result(questionIndex: number): QuestionnaireResult {
  return {
    answers: [
      {
        questionIndex,
        question: `Question ${questionIndex}`,
        kind: 'option',
        answer: `Answer ${questionIndex}`,
      },
    ],
    cancelled: false,
  };
}

describe('QuestionnaireCoordinator', () => {
  it('runs interactions one at a time in FIFO order', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const first = deferred<QuestionnaireResult>();
    const second = deferred<QuestionnaireResult>();
    const starts: number[] = [];

    const firstResult = coordinator.enqueue(() => {
      starts.push(1);
      return first.promise;
    });
    const secondResult = coordinator.enqueue(() => {
      starts.push(2);
      return second.promise;
    });

    expect(starts).toEqual([1]);
    first.resolve(result(1));
    await expect(firstResult).resolves.toEqual(result(1));
    await vi.waitFor(() => expect(starts).toEqual([1, 2]));
    second.resolve(result(2));
    await expect(secondResult).resolves.toEqual(result(2));
  });

  it('cancels a queued interaction without starting it', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const active = deferred<QuestionnaireResult>();
    const queuedAbort = new AbortController();
    const queuedRunner = vi.fn(async () => result(2));

    const activeResult = coordinator.enqueue(() => active.promise);
    const queuedResult = coordinator.enqueue(queuedRunner, queuedAbort.signal);
    queuedAbort.abort();

    await expect(queuedResult).resolves.toEqual({ answers: [], cancelled: true });
    expect(queuedRunner).not.toHaveBeenCalled();
    active.resolve(result(1));
    await activeResult;
  });

  it('preserves reported partial answers when the active interaction is aborted', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const abort = new AbortController();
    let ownedSignal: AbortSignal | undefined;

    const interaction = coordinator.enqueue(({ signal, reportProgress }) => {
      ownedSignal = signal;
      reportProgress(result(1));
      return new Promise<QuestionnaireResult>(() => undefined);
    }, abort.signal);
    abort.abort();

    await expect(interaction).resolves.toEqual({
      answers: result(1).answers,
      cancelled: true,
    });
    expect(ownedSignal?.aborted).toBe(true);
  });

  it('ignores a stale completion after cancellation and advances the queue', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const abort = new AbortController();
    const stale = deferred<QuestionnaireResult>();
    const next = deferred<QuestionnaireResult>();
    const starts: number[] = [];

    const staleResult = coordinator.enqueue(() => {
      starts.push(1);
      return stale.promise;
    }, abort.signal);
    const nextResult = coordinator.enqueue(() => {
      starts.push(2);
      return next.promise;
    });

    abort.abort();
    await expect(staleResult).resolves.toEqual({ answers: [], cancelled: true });
    expect(starts).toEqual([1, 2]);
    stale.resolve(result(99));
    next.resolve(result(2));
    await expect(nextResult).resolves.toEqual(result(2));
  });

  it('rejects a failed active runner and continues with the next interaction', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const failed = deferred<QuestionnaireResult>();
    const nextRunner = vi.fn(async () => result(2));

    const failedResult = coordinator.enqueue(() => failed.promise);
    const nextResult = coordinator.enqueue(nextRunner);
    failed.reject(new Error('presentation failed'));

    await expect(failedResult).rejects.toThrow('presentation failed');
    await expect(nextResult).resolves.toEqual(result(2));
    expect(nextRunner).toHaveBeenCalledOnce();
  });

  it('ignores progress reported by a cancelled stale runner', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const abort = new AbortController();
    let staleContext: QuestionnaireRunContext | undefined;

    const interaction = coordinator.enqueue((context) => {
      staleContext = context;
      return new Promise<QuestionnaireResult>(() => undefined);
    }, abort.signal);
    abort.abort();
    staleContext?.reportProgress(result(9));

    await expect(interaction).resolves.toEqual({ answers: [], cancelled: true });
  });

  it('waits for a cancelled presenter to finish its pending cleanup', async () => {
    const coordinator = new QuestionnaireCoordinator();
    const presenter = deferred<QuestionnaireResult>();
    const interaction = coordinator.enqueue(() => presenter.promise);
    coordinator.shutdown();
    let idle = false;
    const waiting = coordinator.waitForIdle().then(() => {
      idle = true;
    });

    await expect(interaction).resolves.toEqual({ answers: [], cancelled: true });
    await Promise.resolve();
    expect(idle).toBe(false);
    presenter.resolve(result(1));
    await waiting;
    expect(idle).toBe(true);
  });

  it('drains active and queued interactions on shutdown and stops accepting work', async () => {
    const coordinator = new QuestionnaireCoordinator();
    let activeContext: QuestionnaireRunContext | undefined;
    const queuedRunner = vi.fn(async () => result(2));

    const activeResult = coordinator.enqueue((context) => {
      activeContext = context;
      return new Promise<QuestionnaireResult>(() => undefined);
    });
    const queuedResult = coordinator.enqueue(queuedRunner);
    coordinator.shutdown();
    coordinator.shutdown();

    await expect(activeResult).resolves.toEqual({ answers: [], cancelled: true });
    await expect(queuedResult).resolves.toEqual({ answers: [], cancelled: true });
    await expect(coordinator.enqueue(async () => result(3))).resolves.toEqual({
      answers: [],
      cancelled: true,
    });
    expect(activeContext?.signal.aborted).toBe(true);
    expect(queuedRunner).not.toHaveBeenCalled();
  });
});
