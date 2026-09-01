/**
 * Global admission control for child spawns: how many children may be ALIVE at
 * once in this process, as opposed to how fast they are started.
 *
 * WHY THIS EXISTS ON TOP OF `runWithConcurrency`:
 * `runWithConcurrency` throttles START RATE only. `spawnOneChild` resolves as
 * soon as its child confirms it started, and the child then runs detached, so
 * `{tasks: [8], concurrency: 4}` still ends up with eight live model
 * processes. Worse, `spawnPlan.ts`'s `maxTasks` refusal is PER CALL, so K
 * overlapping calls used to yield up to `maxTasks * K` live children with
 * nothing in between them and the machine.
 *
 * WHY IT IS A THIN LAYER OVER `runRegistry`, NOT A NEW SUBSYSTEM:
 * `runRegistry` already records every started run against its session scope
 * and already answers liveness by pid. A child that dies without calling
 * `releaseRun` therefore frees its slot on the next `pruneDeadRuns`, with no
 * separate bookkeeping to keep in sync and no way for this gate to leak a slot
 * across a crash. The only state this gate owns is the RESERVATION window: the
 * gap between admitting a spawn and that spawn registering itself.
 *
 * DESIGN PATTERNS:
 * - Counting is a port (`LiveRunCounter`), so a test never probes a real pid,
 *   the same reason `PidLivenessProbe` exists in `runRegistry`
 * - Admissions are serialized through an internal FIFO queue. Two concurrent
 *   `admit()` calls that each read the count before either reserved would both
 *   see room and both be admitted, which is exactly the over-admission this
 *   module exists to prevent
 * - Waiting is a plain injected sleep, not a `PollScheduler` subscription.
 *   `PollScheduler` is a registry of periodic subscribers sharing one timer;
 *   a one-shot "wait for a slot, then continue" is not that shape, and
 *   registering/unregistering a subscriber per queued child would be more
 *   moving parts for less determinism in tests
 *
 * AVOID:
 * - Admitting on timeout. A gate that gives up and lets the child through is
 *   not a gate; a refused child is a per-child `{error}` outcome, which is the
 *   failure mode `spawnPlan.ts` already handles
 */

import { defaultPidLiveness, listRuns, pruneDeadRuns, type PidLivenessProbe } from '../../runRegistry';
import { tryCurrentSessionScope } from '../../filesystem/paths';
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

/** Live children, counted however the caller can count them. Dead pids must not count. */
export type LiveRunCounter = () => number | Promise<number>;

export interface AdmissionRequest {
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

/**
 * Counts the live runs this process owns, from the registry.
 *
 * Scoped to the current session scope rather than every scope on disk: every
 * child this process starts registers under that one scope, so this is the
 * process's own footprint. Runs owned by OTHER processes are deliberately not
 * counted; this gate bounds what this process does, and cannot bound what it
 * did not start.
 */
export function registryLiveRunCounter(isAlive: PidLivenessProbe = defaultPidLiveness): LiveRunCounter {
  return () => {
    const scope = tryCurrentSessionScope();
    if (!scope) return 0;
    // A child that died without calling `releaseRun` frees its slot here.
    pruneDeadRuns(scope, isAlive);
    return listRuns(scope).filter((run) => isAlive(run.pid)).length;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface AdmissionGateOptions {
  countLiveRuns?: LiveRunCounter;
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

  constructor(options: AdmissionGateOptions = {}) {
    this.countLiveRuns = options.countLiveRuns ?? registryLiveRunCounter();
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
      const live = (await this.countLiveRuns()) + this.reserved;
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

let sharedGate: AdmissionGate | undefined;

/**
 * The one gate every spawn in this process goes through. Process-wide by
 * design: a per-planner or per-call gate would reproduce the per-call bound
 * this module exists to replace.
 */
export function sharedAdmissionGate(): AdmissionGate {
  sharedGate ??= new AdmissionGate();
  return sharedGate;
}
