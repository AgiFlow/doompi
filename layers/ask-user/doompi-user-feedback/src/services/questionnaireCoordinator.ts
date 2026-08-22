import type { QuestionnaireResult } from '../types/questionnaire.js';

export interface QuestionnaireRunContext {
  signal: AbortSignal;
  reportProgress: (result: QuestionnaireResult) => void;
}

export type QuestionnaireRunner = (context: QuestionnaireRunContext) => Promise<QuestionnaireResult>;

interface QueueEntry {
  id: number;
  runner: QuestionnaireRunner;
  controller: AbortController;
  externalSignal?: AbortSignal;
  removeAbortListener?: () => void;
  latestAnswers: QuestionnaireResult['answers'];
  state: 'queued' | 'active' | 'settled';
  resolve(result: QuestionnaireResult): void;
  reject(error: unknown): void;
}

function cancelledResult(entry: QueueEntry): QuestionnaireResult {
  return {
    answers: entry.latestAnswers.map((answer) => ({ ...answer })),
    cancelled: true,
  };
}

export class QuestionnaireCoordinator {
  private readonly pending: QueueEntry[] = [];
  private readonly running = new Set<Promise<QuestionnaireResult>>();
  private active: QueueEntry | undefined;
  private nextRequestId = 1;
  private accepting = true;

  enqueue(runner: QuestionnaireRunner, externalSignal?: AbortSignal): Promise<QuestionnaireResult> {
    if (!this.accepting || externalSignal?.aborted) {
      return Promise.resolve({ answers: [], cancelled: true });
    }

    return new Promise<QuestionnaireResult>((resolve, reject) => {
      const entry: QueueEntry = {
        id: this.nextRequestId,
        runner,
        controller: new AbortController(),
        ...(externalSignal ? { externalSignal } : {}),
        latestAnswers: [],
        state: 'queued',
        resolve,
        reject,
      };
      this.nextRequestId += 1;
      const abort = (): void => this.cancel(entry);
      externalSignal?.addEventListener('abort', abort, { once: true });
      entry.removeAbortListener = () => externalSignal?.removeEventListener('abort', abort);
      this.pending.push(entry);
      this.startNext();
    });
  }

  shutdown(): void {
    if (!this.accepting && !this.active && this.pending.length === 0) return;
    this.accepting = false;
    if (this.active) this.cancel(this.active);
    while (this.pending.length > 0) {
      const entry = this.pending[0];
      if (!entry) break;
      this.cancel(entry);
    }
  }

  /** Waits for every started presenter to observe cancellation and finish. */
  async waitForIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled(this.running);
  }

  private startNext(): void {
    if (!this.accepting || this.active) return;
    const entry = this.pending.shift();
    if (!entry) return;
    entry.state = 'active';
    this.active = entry;
    const reportProgress = (result: QuestionnaireResult): void => {
      if (this.active?.id !== entry.id || entry.state !== 'active') return;
      entry.latestAnswers = result.answers.map((answer) => ({ ...answer }));
    };
    let operation: Promise<QuestionnaireResult>;
    try {
      operation = entry.runner({ signal: entry.controller.signal, reportProgress });
    } catch (error) {
      operation = Promise.reject(error);
    }
    this.running.add(operation);
    void operation
      .then(
        (result) => this.complete(entry, result),
        (error: unknown) => this.fail(entry, error),
      )
      .finally(() => this.running.delete(operation));
  }

  private complete(entry: QueueEntry, result: QuestionnaireResult): void {
    if (this.active?.id !== entry.id || entry.state !== 'active') return;
    this.releaseActive(entry);
    entry.resolve(result);
    this.startNext();
  }

  private fail(entry: QueueEntry, error: unknown): void {
    if (this.active?.id !== entry.id || entry.state !== 'active') return;
    this.releaseActive(entry);
    entry.reject(error);
    this.startNext();
  }

  private cancel(entry: QueueEntry): void {
    if (entry.state === 'settled') return;
    if (entry.state === 'queued') {
      const index = this.pending.indexOf(entry);
      this.pending.splice(index, 1);
      entry.state = 'settled';
      entry.removeAbortListener?.();
      entry.controller.abort();
      entry.resolve(cancelledResult(entry));
      return;
    }

    const result = cancelledResult(entry);
    this.releaseActive(entry);
    entry.controller.abort();
    entry.resolve(result);
    this.startNext();
  }

  private releaseActive(entry: QueueEntry): void {
    entry.state = 'settled';
    entry.removeAbortListener?.();
    this.active = undefined;
  }
}
