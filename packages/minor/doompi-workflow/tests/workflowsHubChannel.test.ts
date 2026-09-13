import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-core/hub-channel';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkflowsChannel } from '../src/controllers/workflowsHubChannel';
import { presentWorkflowRuns, runBelongsToSession } from '../src/services/workflowRuns';
import { readWorkflowRuns } from '../src/services/workflowWatcher';
import { moveWorkflowRun, writeWorkflowRun } from './support/workflowRuns';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-wfchan-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

interface FakeHost extends DoomHubChannelHost {
  published: Array<{ sessionId: string; payload: unknown }>;
  emit(sessionId: string, payload: unknown): void;
}

function fakeHost(scopes: DoomHubSessionScope[]): FakeHost {
  const published: FakeHost['published'] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (sessionId: string): string => `workflow_runs:${sessionId}`;
  return {
    published,
    sessions: () => scopes,
    directEvents: {
      publish: (frameType, sessionId, payload) => {
        for (const listener of listeners.get(`${frameType}:${sessionId}`) ?? []) listener(payload);
      },
      subscribe: (frameType, sessionId, listener) => {
        const eventKey = `${frameType}:${sessionId}`;
        const current = listeners.get(eventKey) ?? new Set<(payload: unknown) => void>();
        current.add(listener);
        listeners.set(eventKey, current);
        return () => {
          current.delete(listener);
          if (current.size === 0) listeners.delete(eventKey);
        };
      },
      close: () => listeners.clear(),
    },
    emit: (sessionId, payload) => {
      for (const listener of listeners.get(key(sessionId)) ?? []) listener(payload);
    },
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'not implemented' }, { status: 501 })),
    onNotice: () => undefined,
  };
}

function payloadForSession(home: string, sessionId: string) {
  const parsed = readWorkflowRuns({ homeDir: home }).filter((run) => runBelongsToSession(run, sessionId));
  return {
    runs: presentWorkflowRuns(
      parsed.map((run) => run.view),
      Date.now(),
    ),
  };
}

function runsOf(payload: unknown): Array<Record<string, unknown>> {
  return (payload as { runs: Array<Record<string, unknown>> }).runs;
}

describe('the workflows hub channel', () => {
  it('seeds owned runs once and accepts lifecycle updates through direct events', () => {
    const home = freshHome();
    const scope = { sessionId: 'owner', cwd: '/nowhere' };
    const host = fakeHost([scope]);
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'mine',
      record: { env: { PI_SESSION_ID: 'owner' } },
      progress: [{ type: 'job', status: 'running', job: 'build', index: 0, total: 1, at: new Date().toISOString() }],
    });
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'foreign',
      record: { env: { PI_SESSION_ID: 'someone-else' } },
    });

    const source = createWorkflowsChannel({ read: () => readWorkflowRuns({ homeDir: home }) }).start(host);
    cleanups.push(() => source.close());
    source.sessionAdded?.(scope);

    expect(host.published).toHaveLength(1);
    expect(host.published[0]?.sessionId).toBe('owner');
    expect(runsOf(host.published[0]?.payload).map((run) => run.runKey)).toEqual(['mine']);
    expect(runsOf(source.payloadFor(scope)).map((run) => run.runKey)).toEqual(['mine']);

    moveWorkflowRun(home, { workspace: 'default', runKey: 'mine' }, 'running', 'error', {
      outcome: 'failed',
      errorMessage: 'boom',
      failedJob: 'build',
      finishedAt: new Date().toISOString(),
    });
    host.emit('owner', payloadForSession(home, 'owner'));

    expect(runsOf(source.payloadFor(scope))[0]).toMatchObject({ errorMessage: 'boom', failedJob: 'build' });
    expect(host.published).toHaveLength(2);
  });

  it('keeps two sessions isolated in one repository', () => {
    const home = freshHome();
    const first = { sessionId: 'first', cwd: '/workspace' };
    const second = { sessionId: 'second', cwd: '/workspace' };
    const host = fakeHost([first, second]);
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'first-run',
      record: { env: { PI_SESSION_ID: 'first' } },
    });
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'second-run',
      record: { env: { PI_SESSION_ID: 'second' } },
    });

    const source = createWorkflowsChannel({ read: () => readWorkflowRuns({ homeDir: home }) }).start(host);
    cleanups.push(() => source.close());
    source.sessionAdded?.(first);
    source.sessionAdded?.(second);

    expect(runsOf(source.payloadFor(first)).map((run) => run.runKey)).toEqual(['first-run']);
    expect(runsOf(source.payloadFor(second)).map((run) => run.runKey)).toEqual(['second-run']);
    for (const entry of host.published) {
      const expected = entry.sessionId === 'first' ? 'first-run' : 'second-run';
      expect(runsOf(entry.payload).map((run) => run.runKey)).toEqual([expected]);
    }
  });
});
