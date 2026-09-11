import { createHeadlessSessionHost } from './headlessSessionHost.ts';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../../types/server/headlessSessionHost.ts';
import type {
  HeadlessSessionManager,
  HeadlessSessionManagerCreateOptions,
} from '../../types/server/headlessSessionManager.ts';

export function createHeadlessSessionManager(): HeadlessSessionManager {
  const sessions = new Map<string, HeadlessSessionHost>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await session.dispose();
  };

  return {
    async create(options: HeadlessSessionManagerCreateOptions): Promise<HeadlessSessionHost> {
      if (closed) throw new Error('The headless session manager is closed.');
      if (sessions.has(options.sessionId)) throw new Error(`Session '${options.sessionId}' already exists.`);
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Session creation was aborted.');

      const { signal, ...hostOptions } = options;
      const session = await createHeadlessSessionHost(hostOptions as HeadlessSessionHostOptions);
      if (closed || signal?.aborted) {
        await session.dispose();
        if (closed) throw new Error('The headless session manager closed during session creation.');
        throw signal?.reason ?? new Error('Session creation was aborted.');
      }
      sessions.set(options.sessionId, session);
      return session;
    },
    get: (sessionId) => sessions.get(sessionId),
    sessions: () => [...sessions.values()],
    closeSession,
    close(): Promise<void> {
      closePromise ??= (async () => {
        if (closed) return;
        closed = true;
        const active = [...sessions.values()].reverse();
        sessions.clear();
        const outcomes = await Promise.allSettled(active.map((session) => session.dispose()));
        const failures = outcomes
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map((outcome) => outcome.reason);
        if (failures.length) throw new AggregateError(failures, 'Headless session manager shutdown failed');
      })();
      return closePromise;
    },
  };
}
