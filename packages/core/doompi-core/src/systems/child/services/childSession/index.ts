import type { TranscriptPage, TranscriptPageRequest } from '../../../../schemas/sessionProtocol';
import type {
  DoomChildSessionEvent,
  DoomChildSessionHandle,
  DoomChildSessionRequest,
  DoomChildSessionRuntimeFactory,
  DoomChildSessionService,
  DoomChildSessionState,
} from '../../types/childSession';

export interface DoomChildSessionServiceDependencies {
  readonly now: () => number;
}

/**
 * Owns lifecycle for runtimes created by a direct host adapter.
 *
 * The factory is the host boundary: it must construct the direct harness, apply
 * history ownership, and return only after child extensions are composed.
 */
export function createDoomChildSessionService(
  factory: DoomChildSessionRuntimeFactory,
  dependencies: DoomChildSessionServiceDependencies,
): DoomChildSessionService {
  const handles = new Map<string, DoomChildSessionHandle>();
  const transcriptReaders = new Map<
    string,
    (request: Omit<TranscriptPageRequest, 'threadId'>, signal?: AbortSignal) => Promise<TranscriptPage>
  >();
  const claimedRunIds = new Set<string>();
  const starting = new Set<Promise<DoomChildSessionHandle>>();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const release = (runId: string): void => {
    handles.delete(runId);
    if (!transcriptReaders.has(runId)) claimedRunIds.delete(runId);
  };
  const recordCleanupFailure = (error: unknown): void => {
    cleanupFailures.push(error);
  };

  const service: DoomChildSessionService = {
    start(request, signal) {
      if (closed) return Promise.reject(new Error('The Doom child-session service is closed.'));
      if (claimedRunIds.has(request.runId))
        return Promise.reject(new Error(`Child run '${request.runId}' already exists.`));
      claimedRunIds.add(request.runId);

      const pending = (async (): Promise<DoomChildSessionHandle> => {
        try {
          signal?.throwIfAborted();
          const handle = await createHandle(
            async (ownedRequest, ownedSignal) => {
              const runtime = await factory(ownedRequest, ownedSignal);
              if (runtime.readTranscriptPage)
                transcriptReaders.set(request.runId, (pageRequest, pageSignal) =>
                  runtime.readTranscriptPage!(pageRequest, pageSignal),
                );
              return runtime;
            },
            dependencies,
            request,
            signal,
            () => release(request.runId),
            recordCleanupFailure,
          );
          if (closed || signal?.aborted) {
            await handle.dispose();
            throw signal?.reason ?? new Error('Child session startup was cancelled.');
          }
          if (!isTerminal(handle.state())) handles.set(request.runId, handle);
          return handle;
        } catch (error) {
          transcriptReaders.delete(request.runId);
          release(request.runId);
          throw error;
        }
      })();
      starting.add(pending);
      void pending.then(
        () => starting.delete(pending),
        () => starting.delete(pending),
      );
      return pending;
    },
    get: (runId) => handles.get(runId),
    async readTranscriptPage(runId, request, signal) {
      if (closed) throw new Error('The Doom child-session service is closed.');
      signal?.throwIfAborted();
      const reader = transcriptReaders.get(runId);
      if (!reader) throw new Error(`Child run '${runId}' has no readable transcript.`);
      const page = await reader(request, signal);
      signal?.throwIfAborted();
      return page;
    },
    close() {
      closePromise ??= (async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled(starting);
        const active = [...handles.values()];
        await Promise.allSettled(active.map((handle) => handle.dispose()));
        const failures = [...cleanupFailures];
        handles.clear();
        transcriptReaders.clear();
        claimedRunIds.clear();
        if (failures.length) throw new AggregateError(failures, 'Doom child-session shutdown failed.');
      })();
      return closePromise;
    },
  };
  return service;
}

function isTerminal(state: DoomChildSessionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown cleanup failure';
}

async function createHandle(
  factory: DoomChildSessionRuntimeFactory,
  dependencies: DoomChildSessionServiceDependencies,
  request: DoomChildSessionRequest,
  signal: AbortSignal | undefined,
  onTerminal: () => void,
  onCleanupFailure: (error: unknown) => void,
): Promise<DoomChildSessionHandle> {
  const runtime = await factory(request, signal);
  if (signal?.aborted) {
    await runtime.dispose();
    throw signal.reason ?? new Error('Child session startup was cancelled.');
  }

  let state: DoomChildSessionState = 'starting';
  let disposed = false;
  let lastEvent: DoomChildSessionEvent | undefined;
  let finishPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let abortCleanup: (() => void) | undefined;
  const listeners = new Set<(event: DoomChildSessionEvent) => void>();
  const sessionFile = runtime.sessionFile;

  const emit = (next: DoomChildSessionState, message?: string): void => {
    state = next;
    const event: DoomChildSessionEvent = {
      runId: request.runId,
      state: next,
      timestamp: dependencies.now(),
      ...(message ? { message } : {}),
      ...(sessionFile ? { sessionFile } : {}),
    };
    lastEvent = event;
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        // Observers must not fault child ownership.
      }
    }
  };

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        await runtime.dispose();
      } finally {
        abortCleanup?.();
        abortCleanup = undefined;
      }
    })();
    return cleanupPromise;
  };

  const finish = (
    next: Extract<DoomChildSessionState, 'completed' | 'failed' | 'stopped'>,
    message?: string,
  ): Promise<void> => {
    finishPromise ??= (async () => {
      let cleanupFailure: unknown;
      try {
        await cleanup();
      } catch (error) {
        cleanupFailure = error;
        onCleanupFailure(error);
      }
      if (cleanupFailure === undefined) {
        emit(next, message);
      } else {
        const detail = errorMessage(cleanupFailure);
        emit('failed', `Child session cleanup failed: ${detail}`);
      }
      disposed = true;
      onTerminal();
      listeners.clear();
      if (cleanupFailure !== undefined) throw cleanupFailure;
    })();
    return finishPromise;
  };

  const handle: DoomChildSessionHandle = {
    runId: request.runId,
    ...(sessionFile ? { sessionFile } : {}),
    state: () => state,
    subscribe(listener) {
      if (disposed || isTerminal(state)) {
        if (lastEvent) {
          try {
            listener(lastEvent);
          } catch {
            // Observers must not fault child ownership.
          }
        }
        return () => false;
      }
      listeners.add(listener);
      if (lastEvent) {
        try {
          listener(lastEvent);
        } catch {
          // Observers must not fault child ownership.
        }
      }
      return () => listeners.delete(listener);
    },
    async steer(message, steerSignal) {
      if (disposed || finishPromise) throw new Error(`Child run '${request.runId}' is no longer active.`);
      steerSignal?.throwIfAborted();
      await runtime.steer(message);
      steerSignal?.throwIfAborted();
    },
    stop(reason) {
      stopPromise ??= (async () => {
        if (finishPromise) return finishPromise;
        let abortFailure: unknown;
        try {
          await runtime.abort();
        } catch (error) {
          abortFailure = error;
        }
        let finishFailure: unknown;
        try {
          await finish('stopped', reason ?? 'Child session stopped.');
        } catch (error) {
          finishFailure = error;
        }
        if (abortFailure !== undefined && finishFailure !== undefined)
          throw new AggregateError([abortFailure, finishFailure], 'Stopping the child session failed.');
        if (abortFailure !== undefined) throw abortFailure;
        if (finishFailure !== undefined) throw finishFailure;
      })();
      return stopPromise;
    },
    dispose: () => finish('stopped', 'Child session disposed.'),
  };

  if (signal) {
    const onAbort = (): void => {
      void handle.stop('Child session startup was cancelled.').catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    abortCleanup = () => signal.removeEventListener('abort', onAbort);
  }
  emit('running');
  void Promise.resolve()
    .then(() => runtime.prompt(request.task))
    .then(
      (message) => finish('completed', typeof message === 'string' ? message : undefined).catch(() => undefined),
      (error: unknown) =>
        finish('failed', error instanceof Error ? error.message : String(error)).catch(() => undefined),
    );
  return handle;
}

export type { DoomChildSessionRuntime } from '../../types/childSession';
