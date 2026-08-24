import type { HubChannelHost } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubagentsChannel } from '../../src/adapters/webSubagentsChannel.ts';
import { removeRunsScope, writeRunStatus } from '../support/webSubagentRuns.ts';

const SESSION = `webchan-${String(process.pid)}-${String(Date.now())}`;

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  removeRunsScope(SESSION);
});

interface FakeHost extends HubChannelHost {
  published: Array<{ sessionId: string; payload: unknown }>;
}

function fakeHost(): FakeHost {
  const published: FakeHost['published'] = [];
  return {
    published,
    sessions: () => [{ sessionId: SESSION, cwd: '/workspace' }],
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

describe('the subagents hub channel', () => {
  it('publishes the session fleet from disk and answers snapshots', { timeout: 15_000 }, async () => {
    const host = fakeHost();
    const channel = createSubagentsChannel();
    const source = channel.start(host);
    cleanups.push(() => source.close());
    expect(channel.frameType).toBe('subagent_runs');

    source.sessionAdded?.({ sessionId: SESSION, cwd: '/workspace' });
    const startedAt = Date.now();
    writeRunStatus(SESSION, {
      version: 1,
      runId: 'run-1',
      agent: 'reviewer',
      state: 'running',
      startedAt,
      lastUpdate: startedAt,
      task: 'Review the diff.',
      cwd: '/workspace',
    });
    await waitFor(
      () => host.published.some((entry) => runsOf(entry.payload).some((run) => run.runId === 'run-1')),
      'the run publishing',
    );
    expect(host.published.every((entry) => entry.sessionId === SESSION)).toBe(true);
    const snapshot = source.payloadFor({ sessionId: SESSION, cwd: '/workspace' });
    expect(runsOf(snapshot)[0]).toMatchObject({ agent: 'reviewer', state: 'running' });

    // Removal forgets the session; the snapshot answers nothing afterwards.
    source.sessionRemoved?.(SESSION);
    expect(source.payloadFor({ sessionId: SESSION, cwd: '/workspace' })).toBeUndefined();
  });
});
