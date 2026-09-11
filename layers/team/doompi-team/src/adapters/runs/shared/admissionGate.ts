/**
 * Serial admission control for child spawns.
 *
 * The owning session runtime injects an in-memory live-run counter backed by
 * direct child events. No process ids or durable files participate in liveness.
 */

import type { SessionScope } from '../../filesystem/paths';
import type { ConcurrencyEventReporter } from './runWithConcurrency';

/** How often a waiting spawn re-checks for a free slot. */
export const DEFAULT_ADMISSION_POLL_INTERVAL_MS = 250;

/**
 * How long a spawn waits for a slot before it is refused.
 *
 * Generous on purpose: children are long-lived, so a queued child behind a
 * saturated machine is normal, and turning that into an error too eagerly
 * would be a worse regression than the wait it replaces.
 */
export const DEFAULT_ADMISSION_TIMEOUT_MS = 300_000;

/** Live children, counted however the caller can count them. */
export type LiveRunCounter = (scope: SessionScope) => number | Promise<number>;

export interface AdmissionRequest {
  /** Session whose child runs are being admitted. */
  sessionScope: SessionScope;
  /** Maximum children alive at once, across every concurrent call in this process. */
  maxLiveRuns: number;
  /** How long to wait for a slot before refusing. */
  timeoutMs: number;
  report?: ConcurrencyEventReporter;
}

export interface AdmissionTicket {
  /** Give the slot back. Idempotent; safe to call from a `finally`. */
  release(): void;
}

export interface AdmissionGateContract {
  admit(request: AdmissionRequest): Promise<AdmissionTicket>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface AdmissionGateOptions {
  countLiveRuns: LiveRunCounter;
  wait?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  now?: () => number;
}

export class AdmissionGate implements AdmissionGateContract {
  private readonly countLiveRuns: LiveRunCounter;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  /** Admitted spawns that have not registered themselves yet. */
  private reserved = 0;
  /** Serializes admissions so no two callers can read the same free slot. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AdmissionGateOptions) {
    this.countLiveRuns = options.countLiveRuns;
    this.wait = options.wait ?? sleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ADMISSION_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  admit(request: AdmissionRequest): Promise<AdmissionTicket> {
    const admission = this.queue.then(
      () => this.waitForSlot(request),
      () => this.waitForSlot(request),
    );
    this.queue = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission;
  }

  private async waitForSlot(request: AdmissionRequest): Promise<AdmissionTicket> {
    const deadline = this.now() + request.timeoutMs;
    const waitStartedAt = this.now();
    let waited = false;

    for (;;) {
      const live = (await this.countLiveRuns(request.sessionScope)) + this.reserved;
      if (live < request.maxLiveRuns) {
        this.reserved += 1;
        return this.ticket();
      }
      if (!waited) {
        waited = true;
        request.report?.('doom_team.admission_wait', {
          'team.live_runs': live,
          'team.max_live_runs': request.maxLiveRuns,
        });
      }
      if (this.now() >= deadline) {
        request.report?.('doom_team.admission_timeout', {
          'team.live_runs': live,
          'team.max_live_runs': request.maxLiveRuns,
          duration_ms: this.now() - waitStartedAt,
        });
        throw new Error(
          `No child slot became available within ${request.timeoutMs}ms: ${live} of at most ${request.maxLiveRuns} children are already running. Wait for running children to finish, or raise parallel.maxLiveRuns in the subagent config.`,
        );
      }
      await this.wait(this.pollIntervalMs);
    }
  }

  private ticket(): AdmissionTicket {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reserved -= 1;
      },
    };
  }
}
