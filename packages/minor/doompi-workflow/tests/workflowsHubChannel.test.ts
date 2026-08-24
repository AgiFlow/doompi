import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubChannelHost, HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowsChannel } from '../src/adapters/workflowsHubChannel.ts';
import { watchWorkflowRuns } from '../src/adapters/workflowWatcher.ts';
import { moveWorkflowRun, writeWorkflowRun } from './support/workflowRuns.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-wfchan-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

interface FakeHost extends HubChannelHost {
  published: Array<{ sessionId: string; payload: unknown }>;
}

function fakeHost(scopes: HubSessionScope[]): FakeHost {
  const published: FakeHost['published'] = [];
  return {
    published,
    sessions: () => scopes,
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

describe('the workflows hub channel', () => {
  it('publishes owned runs per session and answers snapshots, dropping foreign runs', { timeout: 15_000 }, async () => {
    const home = freshHome();
    const host = fakeHost([{ sessionId: 'owner', cwd: '/nowhere' }]);
    const channel = createWorkflowsChannel({ watch: (onRuns) => watchWorkflowRuns(onRuns, { homeDir: home }) });
    const source = channel.start(host);
    cleanups.push(() => source.close());
    expect(channel.frameType).toBe('workflow_runs');

    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'foreign',
      record: { env: { PI_SESSION_ID: 'someone-else' }, workflowPath: '/elsewhere/wf.workflow.yml' },
    });
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'mine',
      record: { env: { PI_SESSION_ID: 'owner' } },
      progress: [{ type: 'job', status: 'running', job: 'build', index: 0, total: 1, at: new Date().toISOString() }],
    });

    await waitFor(
      () => host.published.some((entry) => runsOf(entry.payload).some((run) => run.runKey === 'mine')),
      'the owned run publishing',
    );
    expect(host.published.every((entry) => entry.sessionId === 'owner')).toBe(true);
    expect(runsOf(host.published.at(-1)?.payload).map((run) => run.runKey)).toEqual(['mine']);

    // Snapshot recomputes on demand for a scope the watcher has never seen.
    const snapshot = source.payloadFor({ sessionId: 'owner', cwd: '/nowhere' });
    expect(runsOf(snapshot).map((run) => run.runKey)).toEqual(['mine']);
    expect(runsOf(snapshot)[0]).toMatchObject({ stage: 'running', position: { job: 'build' } });

    // A failure moves the run to the error stage and republishes.
    moveWorkflowRun(home, { workspace: 'default', runKey: 'mine' }, 'running', 'error', {
      outcome: 'failed',
      errorMessage: 'boom',
      failedJob: 'build',
      finishedAt: new Date().toISOString(),
    });
    await waitFor(
      () => host.published.some((entry) => runsOf(entry.payload).some((run) => run.stage === 'error')),
      'the failure publishing',
    );
    expect(runsOf(source.payloadFor({ sessionId: 'owner', cwd: '/nowhere' }))[0]).toMatchObject({
      errorMessage: 'boom',
      failedJob: 'build',
    });
  });
});
