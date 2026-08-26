import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubChannelHost } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnersChannel } from '../src/adapters/webRunnersChannel.ts';
import { runnerStateDirFor, watchRunnerRuns } from '../src/adapters/webRunnerWatcher.ts';
import type { RunnerRecord } from '../src/types/runnerRegistry';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshStore(): string {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-runner-chan-'));
  cleanups.push(() => fs.rmSync(store, { recursive: true, force: true }));
  return store;
}

function writeRecord(store: string, sessionId: string, overrides: Partial<RunnerRecord>): void {
  const dir = runnerStateDirFor(store, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const record: RunnerRecord = {
    id: 'runner-a',
    name: 'api',
    pid: 42,
    command: 'pnpm dev',
    cwd: '/repo',
    logPath: '/tmp/api.log',
    interactive: false,
    sessionId,
    startedAt: new Date().toISOString(),
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 7,
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
}

interface FakeHost extends HubChannelHost {
  published: Array<{ sessionId: string; payload: unknown }>;
}

function fakeHost(): FakeHost {
  const published: FakeHost['published'] = [];
  return {
    published,
    sessions: () => [],
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    onNotice: () => undefined,
  };
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

function runsOf(payload: unknown): Array<Record<string, unknown>> {
  return (payload as { runs: Array<Record<string, unknown>> }).runs;
}

describe('the runners hub channel', () => {
  it(
    'watches each session state directory, publishes changes, and answers snapshots',
    { timeout: 15_000 },
    async () => {
      const store = freshStore();
      const host = fakeHost();
      const channel = createRunnersChannel((sessionId, onRuns) =>
        watchRunnerRuns(sessionId, onRuns, { storeDir: store }),
      );
      const source = channel.start(host);
      cleanups.push(() => source.close());
      expect(channel.frameType).toBe('runner_runs');

      source.sessionAdded?.({ sessionId: 's1', cwd: '/repo' });
      // Nothing on disk yet: no snapshot, no announcement.
      expect(source.payloadFor({ sessionId: 's1', cwd: '/repo' })).toBeUndefined();
      expect(host.published).toEqual([]);

      writeRecord(store, 's1', {});
      writeRecord(store, 's1', { id: 'runner-b', name: 'worker', command: 'pnpm worker' });
      // A sidecar next to the records is not a record.
      fs.writeFileSync(path.join(runnerStateDirFor(store, 's1'), 'runner-a.exit.json'), '{"code":0}');
      await waitFor(() => host.published.some((entry) => runsOf(entry.payload).length === 2), 'both runners');
      const snapshot = source.payloadFor({ sessionId: 's1', cwd: '/repo' });
      expect(
        runsOf(snapshot)
          .map((run) => String(run.id))
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(['runner-a', 'runner-b']);

      writeRecord(store, 's1', {
        state: 'completed',
        exit: {
          reason: 'stopped',
          code: null,
          signal: null,
          stopReason: 'manual',
          finishedAt: new Date().toISOString(),
        },
      });
      await waitFor(
        () => runsOf(host.published.at(-1)?.payload).some((run) => run.id === 'runner-a' && run.state === 'completed'),
        'the stop to publish',
      );
      // Finished runs sort after running ones.
      expect(runsOf(host.published.at(-1)?.payload).map((run) => run.id)).toEqual(['runner-b', 'runner-a']);

      // Another session's directory is another session's feed.
      writeRecord(store, 's2', { id: 'runner-c' });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(host.published.every((entry) => entry.sessionId === 's1')).toBe(true);

      source.sessionRemoved?.('s1');
      expect(source.payloadFor({ sessionId: 's1', cwd: '/repo' })).toBeUndefined();
    },
  );
});
