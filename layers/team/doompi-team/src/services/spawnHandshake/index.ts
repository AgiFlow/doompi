import type { ExternalProcessEndpoint, ExternalRunnerMessage } from '../externalProcessIpc';
import { parseExternalRunnerMessage } from '../externalProcessIpc';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SpawnHandshakeOptions {
  /** Bounded parent-child process IPC endpoint for this runner. */
  child: ExternalProcessEndpoint;
  /** Exact run identity accepted from the child. */
  runId: string;
  /** Exact session scope accepted from the child. */
  scopeKey: string;
  timeoutMs?: number;
}

export type SpawnHandshakeOutcome =
  | { status: 'signalled' }
  | { status: 'failed'; error: string }
  | { status: 'timed-out' };

export interface SpawnHandshakeWait {
  promise: Promise<SpawnHandshakeOutcome>;
  /** Reject early and tear down. */
  cancel: (reason: string) => void;
}

export type SpawnHandshakeContract = {
  waitForHandshake(options: SpawnHandshakeOptions): SpawnHandshakeWait;
};

export class SpawnHandshake implements SpawnHandshakeContract {
  protected readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS;

  waitForHandshake(options: SpawnHandshakeOptions): SpawnHandshakeWait {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    let settled = false;
    let removeMessage: (() => void) | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: ((reason: unknown) => void) | undefined;

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      removeMessage?.();
      removeMessage = undefined;
    };

    const promise = new Promise<SpawnHandshakeOutcome>((resolve, reject) => {
      rejectWait = reject;
      const settle = (outcome: SpawnHandshakeOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      removeMessage = options.child.onMessage((raw) => {
        const message: ExternalRunnerMessage | undefined = parseExternalRunnerMessage(raw, {
          runId: options.runId,
          scopeKey: options.scopeKey,
        });
        if (!message) return;
        if (message.kind === 'ready') settle({ status: 'signalled' });
        else if (message.kind === 'error') settle({ status: 'failed', error: message.error });
      });
      timeoutTimer = setTimeout(() => settle({ status: 'timed-out' }), timeoutMs);
      timeoutTimer.unref?.();
    });

    return {
      promise,
      cancel: (reason: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectWait?.(new Error(reason));
      },
    };
  }
}
