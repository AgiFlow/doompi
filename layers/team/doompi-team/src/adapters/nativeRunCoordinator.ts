import type {
  DoomChildSessionEvent,
  DoomChildSessionHandle,
  DoomChildSessionRequest,
  DoomChildSessionServiceProvider,
} from '@agimon-ai/doompi-extension-contracts/child-session';
import type { SessionScope } from './filesystem/paths';
import type { AsyncJobTracker, NativeAsyncJobProjection } from './asyncJobTracker';
import type { NativeRunProjectionSink } from './nativeRunProjection';
import type { CompletionNotifierContract } from './runs/background/notify';

export interface NativeRunCoordinatorContract {
  start(sessionId: string, request: DoomChildSessionRequest): Promise<DoomChildSessionHandle>;
  get(sessionId: string, runId: string): DoomChildSessionHandle | undefined;
  status(sessionId: string, runId: string): NativeAsyncJobProjection | undefined;
  steer(sessionId: string, runId: string, message: string, signal?: AbortSignal): Promise<void>;
  stop(sessionId: string, runId: string, reason?: string): Promise<void>;
  close(): Promise<void>;
}

interface NativeRunEntry {
  readonly sessionId: string;
  readonly scope: SessionScope;
  readonly request: DoomChildSessionRequest;
  readonly handle: DoomChildSessionHandle;
  unsubscribe?: () => void;
  startedAt?: number;
  terminal: boolean;
}

function terminalState(event: DoomChildSessionEvent): 'completed' | 'failed' | 'stopped' | undefined {
  return event.state === 'completed' || event.state === 'failed' || event.state === 'stopped' ? event.state : undefined;
}

function entryKey(sessionId: string, runId: string): string {
  return JSON.stringify([sessionId, runId]);
}

export class NativeRunCoordinator implements NativeRunCoordinatorContract {
  private readonly entries = new Map<string, NativeRunEntry>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly childSessions: DoomChildSessionServiceProvider | undefined,
    private readonly tracker: AsyncJobTracker,
    private readonly notifier?: CompletionNotifierContract,
    private readonly projection?: NativeRunProjectionSink,
  ) {}

  async start(sessionId: string, request: DoomChildSessionRequest): Promise<DoomChildSessionHandle> {
    if (this.closed) throw new Error('The native Team run coordinator is closed.');
    if (!sessionId.trim()) throw new Error('Native child runs require a session identity.');
    const service = this.childSessions?.get();
    if (!service) throw new Error('The in-process Pi child-session service is unavailable.');
    const handle = await service.start(request);
    if (this.closed) {
      await handle.dispose();
      throw new Error('The native Team run coordinator closed during child startup.');
    }
    const entry: NativeRunEntry = {
      sessionId,
      scope: request.scope,
      request,
      handle,
      terminal: false,
    };
    const key = entryKey(sessionId, request.runId);
    this.entries.set(key, entry);
    try {
      const unsubscribe = handle.subscribe((event) => this.onEvent(entry, event));
      if (entry.terminal) unsubscribe();
      else entry.unsubscribe = unsubscribe;
      return handle;
    } catch (error) {
      this.entries.delete(key);
      await handle.dispose().catch(() => undefined);
      throw error;
    }
  }

  get(sessionId: string, runId: string): DoomChildSessionHandle | undefined {
    return this.entries.get(entryKey(sessionId, runId))?.handle;
  }

  status(sessionId: string, runId: string): NativeAsyncJobProjection | undefined {
    return this.tracker.getNative(sessionId, runId);
  }

  async steer(sessionId: string, runId: string, message: string, signal?: AbortSignal): Promise<void> {
    const handle = this.get(sessionId, runId);
    if (!handle) throw new Error(`No active native run matches '${runId}'.`);
    await handle.steer(message, signal);
  }

  async stop(sessionId: string, runId: string, reason?: string): Promise<void> {
    const handle = this.get(sessionId, runId);
    if (!handle) throw new Error(`No active native run matches '${runId}'.`);
    await handle.stop(reason);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      const active = [...this.entries.values()];
      const outcomes = await Promise.allSettled(active.map((entry) => entry.handle.dispose()));
      for (const entry of active) {
        entry.unsubscribe?.();
        this.entries.delete(entryKey(entry.sessionId, entry.request.runId));
      }
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      if (failures.length) throw new AggregateError(failures, 'Native Team run shutdown failed.');
    })();
    return this.closing;
  }

  private onEvent(entry: NativeRunEntry, event: DoomChildSessionEvent): void {
    entry.startedAt ??= event.timestamp;
    const status = terminalState(event);
    const projection: NativeAsyncJobProjection = {
      runId: event.runId,
      agent: entry.request.agent,
      task: entry.request.task,
      cwd: entry.request.cwd,
      runtime: 'pi',
      status: event.state === 'starting' ? 'queued' : event.state === 'running' ? 'running' : event.state,
      startedAt: entry.startedAt,
      updatedAt: event.timestamp,
      ...(event.message
        ? { error: status === 'failed' || status === 'stopped' ? event.message : undefined, summary: event.message }
        : {}),
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
    };
    this.tracker.upsertNative(entry.sessionId, entry.scope, projection);
    this.projection?.publish(entry.sessionId, projection);
    if (!status || entry.terminal) return;
    entry.terminal = true;
    entry.unsubscribe?.();
    this.entries.delete(entryKey(entry.sessionId, entry.request.runId));
    const result = {
      runId: entry.request.runId,
      agent: entry.request.agent,
      task: entry.request.task,
      cwd: entry.request.cwd,
      runtime: 'pi',
      state: status,
      success: status === 'completed',
      summary:
        event.message ?? (status === 'completed' ? 'Native child run completed.' : `Native child run ${status}.`),
      durationMs: Math.max(
        0,
        event.timestamp - (this.tracker.getNative(entry.sessionId, entry.request.runId)?.startedAt ?? event.timestamp),
      ),
      sessionId: entry.sessionId,
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
    };
    if (this.notifier) {
      void this.notifier
        .deliver(result)
        .then((delivered) => {
          if (delivered) this.tracker.acknowledgeHandoff(entry.sessionId, entry.request.runId);
        })
        .catch(() => undefined);
    }
  }
}
