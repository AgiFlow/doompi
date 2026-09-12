import type { Context } from '@deepseek-ai/cordis';

/** Cordis service name for session-scoped package initialization. */
export const DOOM_READINESS_SERVICE = 'doom/readiness';

/** Stable machine-readable failures produced by the readiness contract. */
export const DOOM_READINESS_ERROR_CODE = {
  cancelled: 'DOOM_READINESS_CANCELLED',
  disposed: 'DOOM_READINESS_DISPOSED',
  duplicate: 'DOOM_READINESS_DUPLICATE',
  failed: 'DOOM_READINESS_FAILED',
  invalidArgument: 'DOOM_READINESS_INVALID_ARGUMENT',
  unavailable: 'DOOM_READINESS_UNAVAILABLE',
  waitAborted: 'DOOM_READINESS_WAIT_ABORTED',
} as const;

export type DoomReadinessErrorCode = (typeof DOOM_READINESS_ERROR_CODE)[keyof typeof DOOM_READINESS_ERROR_CODE];
export type DoomReadinessState = 'pending' | 'ready' | 'degraded' | 'failed' | 'cancelled';

export interface DoomReadinessErrorDetail {
  readonly code: DoomReadinessErrorCode;
  readonly message: string;
}

/** Immutable public state for the latest generation of one package. */
export interface DoomReadinessSnapshot {
  readonly packageId: string;
  readonly generation: string;
  readonly state: DoomReadinessState;
  readonly diagnostics: readonly string[];
  readonly error?: DoomReadinessErrorDetail;
}

export interface DoomReadinessTaskResult<TValue> {
  readonly value: TValue;
  readonly diagnostics?: readonly string[];
}

export type DoomReadinessTask<TValue> = (signal: AbortSignal) => Promise<DoomReadinessTaskResult<TValue>>;

export interface DoomReadinessWaitOptions {
  readonly signal?: AbortSignal;
}

export interface DoomReadinessHandle<TValue> {
  readonly packageId: string;
  readonly generation: string;
  /** Waits for this package only. Degraded initialization still returns its value. */
  wait(options?: DoomReadinessWaitOptions): Promise<TValue>;
  /** Reads this handle's generation, even after a newer generation replaces it. */
  snapshot(): DoomReadinessSnapshot;
}

export interface DoomReadinessNotification {
  readonly packageId: string;
  readonly generation: string;
  readonly state: 'degraded' | 'failed';
  readonly diagnostics: readonly string[];
  readonly error?: DoomReadinessErrorDetail;
}

export interface DoomReadinessCoordinatorOptions {
  /** Called once when a task becomes degraded or failed. */
  readonly notify?: (notification: DoomReadinessNotification) => void | Promise<void>;
}

export interface DoomReadinessCoordinator {
  start<TValue>(packageId: string, generation: string, task: DoomReadinessTask<TValue>): DoomReadinessHandle<TValue>;
  /** Reads the latest generation registered for a package. */
  read(packageId: string): DoomReadinessSnapshot | undefined;
  /** Reads the latest generation of every registered package. */
  snapshots(): readonly DoomReadinessSnapshot[];
  /** Aborts pending work and waits for every started task to settle. */
  dispose(): Promise<void>;
}

interface ReadinessRecord {
  readonly token: symbol;
  readonly packageId: string;
  readonly generation: string;
  readonly controller: AbortController;
  readonly terminal: Promise<void>;
  readonly resolveTerminal: () => void;
  operation: Promise<unknown>;
  state: DoomReadinessState;
  diagnostics: readonly string[];
  error?: DoomReadinessError;
  value?: unknown;
  hasValue: boolean;
  notified: boolean;
}

export interface DoomReadinessErrorOptions {
  readonly packageId?: string;
  readonly generation?: string;
  readonly cause?: unknown;
}

/** Error returned to package callers without exposing task-specific rejection shapes. */
export class DoomReadinessError extends Error {
  readonly code: DoomReadinessErrorCode;
  readonly packageId?: string;
  readonly generation?: string;

  constructor(code: DoomReadinessErrorCode, message: string, input: DoomReadinessErrorOptions = {}) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'DoomReadinessError';
    this.code = code;
    this.packageId = input.packageId;
    this.generation = input.generation;
  }
}

function createTerminal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function frozenDiagnostics(diagnostics: readonly string[] | undefined): readonly string[] {
  if (diagnostics === undefined) return Object.freeze([]);
  if (!Array.isArray(diagnostics) || diagnostics.some((diagnostic) => typeof diagnostic !== 'string')) {
    throw new TypeError('Doom readiness task diagnostics must be an array of strings.');
  }
  return Object.freeze([...diagnostics]);
}

function errorDetail(error: DoomReadinessError | undefined): DoomReadinessErrorDetail | undefined {
  return error === undefined ? undefined : Object.freeze({ code: error.code, message: error.message });
}

function recordSnapshot(record: ReadinessRecord): DoomReadinessSnapshot {
  return Object.freeze({
    packageId: record.packageId,
    generation: record.generation,
    state: record.state,
    diagnostics: record.diagnostics,
    ...(record.error === undefined ? {} : { error: errorDetail(record.error) }),
  });
}

function rethrowAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

function waitAbortedError(record: ReadinessRecord, signal: AbortSignal): DoomReadinessError {
  return new DoomReadinessError(
    DOOM_READINESS_ERROR_CODE.waitAborted,
    `Waiting for Doom package '${record.packageId}' readiness was aborted.`,
    { packageId: record.packageId, generation: record.generation, cause: signal.reason },
  );
}

function waitForTerminal(record: ReadinessRecord, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return record.terminal;
  if (signal.aborted) return Promise.reject(waitAbortedError(record, signal));

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(waitAbortedError(record, signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void record.terminal.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** Creates the session-scoped coordinator value published through Cordis. */
export function createDoomReadinessCoordinator(
  options: DoomReadinessCoordinatorOptions = {},
): DoomReadinessCoordinator {
  const records = new Map<string, ReadinessRecord>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const current = (record: ReadinessRecord): boolean =>
    !disposed && records.get(record.packageId)?.token === record.token && record.state === 'pending';

  const notify = (record: ReadinessRecord): void => {
    if (record.notified || (record.state !== 'degraded' && record.state !== 'failed')) return;
    record.notified = true;
    const notification = Object.freeze({
      packageId: record.packageId,
      generation: record.generation,
      state: record.state,
      diagnostics: record.diagnostics,
      ...(record.error === undefined ? {} : { error: errorDetail(record.error) }),
    });
    if (options.notify) void Promise.resolve(options.notify(notification)).catch(rethrowAsync);
  };

  const finish = (
    record: ReadinessRecord,
    state: Exclude<DoomReadinessState, 'pending'>,
    input: {
      readonly value?: unknown;
      readonly hasValue?: boolean;
      readonly diagnostics?: readonly string[];
      readonly error?: DoomReadinessError;
    } = {},
  ): void => {
    if (!current(record)) return;
    record.state = state;
    record.value = input.value;
    record.hasValue = input.hasValue ?? false;
    record.diagnostics = input.diagnostics ?? Object.freeze([]);
    record.error = input.error;
    record.resolveTerminal();
    notify(record);
  };

  const handleFor = <TValue>(record: ReadinessRecord): DoomReadinessHandle<TValue> =>
    Object.freeze({
      packageId: record.packageId,
      generation: record.generation,
      snapshot: () => recordSnapshot(record),
      wait: async (waitOptions: DoomReadinessWaitOptions = {}): Promise<TValue> => {
        await waitForTerminal(record, waitOptions.signal);
        if (record.state === 'ready' || record.state === 'degraded') {
          if (!record.hasValue) {
            throw new DoomReadinessError(
              DOOM_READINESS_ERROR_CODE.failed,
              `Doom package '${record.packageId}' readiness completed without a value.`,
              { packageId: record.packageId, generation: record.generation },
            );
          }
          return record.value as TValue;
        }
        if (record.error) throw record.error;
        throw new DoomReadinessError(
          DOOM_READINESS_ERROR_CODE.failed,
          `Doom package '${record.packageId}' readiness did not complete.`,
          { packageId: record.packageId, generation: record.generation },
        );
      },
    });

  return Object.freeze({
    start<TValue>(packageId: string, generation: string, task: DoomReadinessTask<TValue>): DoomReadinessHandle<TValue> {
      if (disposed) {
        throw new DoomReadinessError(
          DOOM_READINESS_ERROR_CODE.disposed,
          'The Doom readiness coordinator has been disposed.',
          { packageId, generation },
        );
      }
      if (typeof packageId !== 'string' || packageId.trim().length === 0) {
        throw new DoomReadinessError(
          DOOM_READINESS_ERROR_CODE.invalidArgument,
          'Doom readiness requires a non-empty package id.',
          { packageId, generation },
        );
      }
      if (typeof generation !== 'string' || generation.trim().length === 0) {
        throw new DoomReadinessError(
          DOOM_READINESS_ERROR_CODE.invalidArgument,
          'Doom readiness requires a non-empty generation.',
          { packageId, generation },
        );
      }
      if (typeof task !== 'function') {
        throw new DoomReadinessError(
          DOOM_READINESS_ERROR_CODE.invalidArgument,
          'Doom readiness requires an initialization task.',
          { packageId, generation },
        );
      }

      const previous = records.get(packageId);
      if (previous?.state === 'pending') {
        throw new DoomReadinessError(
          DOOM_READINESS_ERROR_CODE.duplicate,
          `Doom package '${packageId}' already has live readiness work.`,
          { packageId, generation },
        );
      }

      const terminal = createTerminal();
      const controller = new AbortController();
      const record: ReadinessRecord = {
        token: Symbol(packageId),
        packageId,
        generation,
        controller,
        terminal: terminal.promise,
        resolveTerminal: terminal.resolve,
        operation: Promise.resolve(),
        state: 'pending',
        diagnostics: Object.freeze([]),
        hasValue: false,
        notified: false,
      };
      records.set(packageId, record);

      const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return task(controller.signal);
      });
      record.operation = operation;
      void operation
        .then(
          (result) => {
            if (!current(record)) return;
            if (result === null || typeof result !== 'object' || !Object.hasOwn(result, 'value')) {
              finish(record, 'failed', {
                error: new DoomReadinessError(
                  DOOM_READINESS_ERROR_CODE.failed,
                  `Doom package '${packageId}' returned an invalid readiness result.`,
                  { packageId, generation },
                ),
              });
              return;
            }
            try {
              const diagnostics = frozenDiagnostics(result.diagnostics);
              finish(record, diagnostics.length === 0 ? 'ready' : 'degraded', {
                value: result.value,
                hasValue: true,
                diagnostics,
              });
            } catch (error) {
              finish(record, 'failed', {
                error: new DoomReadinessError(
                  DOOM_READINESS_ERROR_CODE.failed,
                  `Doom package '${packageId}' returned an invalid readiness result.`,
                  { packageId, generation, cause: error },
                ),
              });
            }
          },
          (error: unknown) => {
            finish(record, 'failed', {
              error: new DoomReadinessError(
                DOOM_READINESS_ERROR_CODE.failed,
                `Doom package '${packageId}' readiness failed: ${error instanceof Error ? error.message : String(error)}`,
                { packageId, generation, cause: error },
              ),
            });
          },
        )
        .catch(rethrowAsync);

      return handleFor<TValue>(record);
    },

    read(packageId: string): DoomReadinessSnapshot | undefined {
      const record = records.get(packageId);
      return record === undefined ? undefined : recordSnapshot(record);
    },

    snapshots(): readonly DoomReadinessSnapshot[] {
      return Object.freeze([...records.values()].map(recordSnapshot));
    },

    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      const operations = [...records.values()].map((record) => {
        if (record.state === 'pending') {
          const error = new DoomReadinessError(
            DOOM_READINESS_ERROR_CODE.cancelled,
            `Doom package '${record.packageId}' readiness was cancelled.`,
            { packageId: record.packageId, generation: record.generation },
          );
          record.state = 'cancelled';
          record.error = error;
          record.resolveTerminal();
          record.controller.abort(error);
        }
        return record.operation;
      });
      disposal = Promise.allSettled(operations).then(() => undefined);
      return disposal;
    },
  });
}

/** Reads the coordinator visible to the current Cordis plugin context. */
export function readDoomReadinessCoordinator(ctx: Context): DoomReadinessCoordinator | undefined {
  return ctx.get(DOOM_READINESS_SERVICE) as DoomReadinessCoordinator | undefined;
}

/** Reads the coordinator or reports that Config has not published session readiness. */
export function requireDoomReadinessCoordinator(ctx: Context): DoomReadinessCoordinator {
  const coordinator = readDoomReadinessCoordinator(ctx);
  if (coordinator) return coordinator;
  throw new DoomReadinessError(
    DOOM_READINESS_ERROR_CODE.unavailable,
    'Doom readiness is unavailable. Load the DoomPi Config core.',
  );
}
