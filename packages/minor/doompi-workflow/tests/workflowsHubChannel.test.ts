import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-core/hubChannel';
import { createHeadlessHub } from '@agimon-ai/doompi-core/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { presentWorkflowRuns, runBelongsToSession } from '../src/services/workflowRuns';
import { createWorkflowsChannel } from '../src/services/workflowsHubChannel';
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
  it('seeds the full definition and overlays progress without losing future or nested steps', () => {
    const home = freshHome();
    const workflowPath = path.join(home, 'release.workflow.yaml');
    fs.writeFileSync(
      workflowPath,
      JSON.stringify({
        name: 'Release',
        pre: { steps: [{ name: 'prepare', run: 'true' }] },
        jobs: {
          publish: { needs: ['build'], steps: [{ name: 'ship', run: 'true' }] },
          '.base': { steps: [{ run: 'true' }] },
          build: {
            extends: '.base',
            preJob: { steps: [{ name: 'before build', run: 'true' }] },
            steps: [{ name: 'checks', parallel: [{ name: 'unit', run: 'true' }, { run: 'true' }] }],
            postJob: { steps: [{ name: 'after build', run: 'true' }] },
          },
        },
        post: { steps: [{ name: 'cleanup', run: 'true' }] },
      }),
    );
    const at = new Date().toISOString();
    const fixture = {
      workspace: 'default',
      stage: 'running' as const,
      record: { workflowPath, env: { PI_SESSION_ID: 'owner' } },
    };
    writeWorkflowRun(home, { ...fixture, runKey: 'not-started' });
    writeWorkflowRun(home, {
      ...fixture,
      runKey: 'moving',
      progress: [
        { type: 'job', status: 'completed', job: 'pre', at },
        { type: 'step', status: 'completed', job: 'pre', step: 'prepare', at },
        { type: 'job', status: 'running', job: 'build', index: 0, total: 2, at },
        {
          type: 'step',
          status: 'running',
          job: 'build',
          step: 'unit',
          group: 'checks',
          ref: { kind: 'session', id: 'child' },
          at,
        },
      ],
    });
    const runs = readWorkflowRuns({ homeDir: home });
    const moving = runs.find((run) => run.view.runKey === 'moving')!.view;
    expect(moving.jobs.map((job) => [job.name, job.status])).toEqual([
      ['pre', 'completed'],
      ['build', 'running'],
      ['publish', 'pending'],
      ['post', 'pending'],
    ]);
    expect(moving.jobs[1]?.steps).toEqual([
      { name: 'before build', status: 'pending' },
      { name: 'step 1', status: 'pending' },
      { name: 'unit', status: 'running', group: 'checks', ref: { kind: 'session', id: 'child' }, startedAt: at },
      { name: 'checks 2', status: 'pending', group: 'checks' },
      { name: 'after build', status: 'pending' },
    ]);
    expect(moving.position).toEqual({ job: 'build', step: 'unit', index: 0, total: 2 });
    expect(
      runs.find((run) => run.view.runKey === 'not-started')?.view.jobs.every((job) => job.status === 'pending'),
    ).toBe(true);

    fs.unlinkSync(workflowPath);
    const fallback = readWorkflowRuns({ homeDir: home }).find((run) => run.view.runKey === 'moving')!.view;
    expect(fallback.jobs.map((job) => job.name)).toEqual(['pre', 'build']);
    expect(fallback.jobs[1]?.steps[0]?.ref?.id).toBe('child');
  });

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

  it('lists the runs a session handed to its workflow sessions, live and after they are released', () => {
    const home = freshHome();
    const parent = { sessionId: 'parent', cwd: '/workspace' };
    const child = { sessionId: 'child', cwd: '/workspace' };
    const host = fakeHost([parent, child]);
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'running',
      runKey: 'handed-run',
      record: { env: { PI_SESSION_ID: 'child', DOOMPI_WORKFLOW_LAUNCHER_SESSION_ID: 'parent' } },
    });
    writeWorkflowRun(home, {
      workspace: 'default',
      stage: 'completed',
      runKey: 'released-run',
      record: { env: { PI_SESSION_ID: 'gone', DOOMPI_WORKFLOW_LAUNCHER_SESSION_ID: 'parent' }, outcome: 'success' },
    });

    const source = createWorkflowsChannel({ read: () => readWorkflowRuns({ homeDir: home }) }).start(host);
    cleanups.push(() => source.close());
    source.sessionAdded?.(parent);
    source.sessionAdded?.(child);

    // The registry seeds both, the released workflow session's run included.
    expect(
      runsOf(source.payloadFor(parent))
        .map((run) => String(run.runKey))
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['handed-run', 'released-run']);
    expect(runsOf(source.payloadFor(child)).map((run) => run.runKey)).toEqual(['handed-run']);
    expect(runsOf(source.payloadFor(parent)).find((run) => run.runKey === 'handed-run')).toMatchObject({
      ownerSessionId: 'child',
      launcherSessionId: 'parent',
    });

    // The owner's live update reaches its launcher without the launcher publishing anything.
    const update = runsOf(source.payloadFor(child)).map((run) => ({ ...run, position: { job: 'build' } }));
    host.emit('child', { runs: update });
    expect(runsOf(source.payloadFor(parent)).find((run) => run.runKey === 'handed-run')).toMatchObject({
      position: { job: 'build' },
    });

    // The launcher's own update keeps the handed runs beside its own.
    host.emit('parent', { runs: [] });
    expect(
      runsOf(source.payloadFor(parent))
        .map((run) => String(run.runKey))
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['handed-run', 'released-run']);

    // A removed workflow session's rows stay with its launcher.
    source.sessionRemoved?.('child');
    expect(runsOf(source.payloadFor(parent)).map((run) => run.runKey)).toContain('handed-run');
  });

  it('routes a workflow session update to its launcher through a real hub', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    const host = {
      runtime: { exited: new Promise<number>(() => undefined) },
      prepareFacets: async () => undefined,
      activateFacets: async () => undefined,
      canDispatch: () => true,
      onPresentationFrame: () => () => undefined,
      respondToExtensionUi: () => false,
      dispose: vi.fn(async () => undefined),
    } as never;
    hub.registerChannel(createWorkflowsChannel({ read: () => [] }));
    hub.registerChannel(createWorkflowsChannel({ read: () => [] }), { scope: 'workspace', workspaceId: 'ws' });
    hub.register({ id: 'parent', name: 'parent', cwd: '/w', createdAt: 'now', workspaceId: 'ws', host } as never);
    hub.register({ id: 'child', name: 'child', cwd: '/w', createdAt: 'now', workspaceId: 'ws', host } as never);
    const run = {
      runKey: 'handed',
      workspace: 'default',
      displayName: 'Handed',
      workflowPath: '/w/handed.workflow.yml',
      stage: 'running',
      startedAt: new Date().toISOString(),
      ownerSessionId: 'child',
      launcherSessionId: 'parent',
      jobs: [],
    };
    hub.directEvents.publish('workflow_runs', 'child', { runs: [run] });
    expect(hub.channelFrames('parent')).toEqual([
      { type: 'workflow_runs', sessionId: 'parent', payload: { runs: [run] } },
    ]);
    await hub.close();
  });
});
