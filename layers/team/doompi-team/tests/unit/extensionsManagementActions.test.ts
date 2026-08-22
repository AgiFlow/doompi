import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ManagementActions } from '../../src/adapters/pi/extensions/managementActions';
import { controlInboxDir, steerRequestsDir, writeSteerAck } from '../../src/adapters/intercom/supervisorControlChannel';
import type { AsyncRunStatus } from '../../src/adapters/runs/background/asyncExecution';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type { RunIdResolverContract, ResolvedRunLocation } from '../../src/adapters/runIdResolver';

class FakeRunIdResolver implements RunIdResolverContract {
  locations = new Map<string, ResolvedRunLocation>();
  resolve(id: string): ResolvedRunLocation | undefined {
    if (id === 'ambiguous')
      throw new Error(`Ambiguous run id prefix '${id}' matched: run-a, run-b. Provide a longer id.`);
    return this.locations.get(id);
  }
  async resolveAsync(id: string): Promise<ResolvedRunLocation | undefined> {
    return this.resolve(id);
  }
}

class FakeAsyncJobTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  jobs: TrackedAsyncJob[] = [];
  list(): TrackedAsyncJob[] {
    return this.jobs;
  }
  get(runId: string): TrackedAsyncJob | undefined {
    return this.jobs.find((job) => job.runId === runId);
  }
  track(): void {}
  untrack(): void {}
  reset(): void {}
  start(): void {}
  stop(): void {}
}

const temporaryDirs: string[] = [];

function makeRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-management-actions-'));
  temporaryDirs.push(dir);
  return dir;
}

function writeStatus(runDir: string, status: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(status));
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeActions() {
  const runIds = new FakeRunIdResolver();
  const jobs = new FakeAsyncJobTracker();
  class FastManagementActions extends ManagementActions {
    protected override readonly steerAckTimeoutMs = 0;
    protected override readonly steerAckPollIntervalMs = 1;
  }
  const actions = new FastManagementActions(runIds, jobs);
  return { runIds, jobs, actions };
}

describe('ManagementActions', () => {
  describe('status', () => {
    it('returns status:undefined, claimed:false, and the requested id back when nothing resolves', () => {
      const { actions } = makeActions();

      const result = actions.status('no-such-run');

      expect(result).toEqual({ runId: 'no-such-run', runDir: undefined, claimed: false, status: undefined });
    });

    it("reads the resolved run's real status.json off disk", () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      writeStatus(runDir, { runId: 'run-1', agent: 'worker', state: 'running', summary: 'in progress' });
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });

      const result = actions.status('run-1');

      expect(result.runId).toBe('run-1');
      expect(result.claimed).toBe(false);
      expect((result.status as AsyncRunStatus | undefined)?.summary).toBe('in progress');
    });

    it('reads status through the promise-based startup path', async () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      writeStatus(runDir, { runId: 'run-async', agent: 'worker', state: 'running' });
      runIds.locations.set('run-async', { runId: 'run-async', runDir, resultPath: undefined, claimed: false });

      await expect(actions.statusAsync('run-async')).resolves.toMatchObject({
        runId: 'run-async',
        status: { state: 'running' },
      });
    });

    it('propagates an ambiguous-prefix throw from the resolver, unmodified', () => {
      const { actions } = makeActions();

      expect(() => actions.status('ambiguous')).toThrow(/Ambiguous run id prefix/);
    });

    it('reports status:undefined when the resolved run has no readable status.json', () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir(); // empty, no status.json written
      runIds.locations.set('run-empty', { runId: 'run-empty', runDir, resultPath: undefined, claimed: false });

      const result = actions.status('run-empty');

      expect(result.status).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns exactly what AsyncJobTracker.list() returns, nothing more', () => {
      const { jobs, actions } = makeActions();
      jobs.jobs = [{ runId: 'run-1', status: 'running' }];

      expect(actions.list()).toEqual({ runs: [{ runId: 'run-1', status: 'running' }] });
    });
  });

  describe('interrupt / stop / steer', () => {
    it('interrupt() throws naming the id when nothing resolves, before writing anything', () => {
      const { actions } = makeActions();
      expect(() => actions.interrupt('ghost')).toThrow(/\[run_not_found\].*No active run matches 'ghost'/);
    });

    it('interrupt() writes a real interrupt request file into the resolved run dir', () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });

      const result = actions.interrupt('run-1', 'user requested');

      expect(fs.existsSync(result.requestPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(result.requestPath, 'utf-8'));
      expect(written).toMatchObject({ type: 'interrupt', reason: 'user requested' });
    });

    it('stop() writes a real stop request file into the resolved run dir', () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });

      const result = actions.stop('run-1');

      expect(fs.existsSync(result.requestPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(result.requestPath, 'utf-8'))).toMatchObject({ type: 'stop' });
    });

    it('steer() writes a real steer request file with the message and optional targetIndex', async () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });

      const result = await actions.steer('run-1', 'go this way', 2);

      expect(fs.existsSync(result.requestPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(result.requestPath, 'utf-8'));
      expect(written).toMatchObject({ message: 'go this way', targetIndex: 2, id: result.requestId });
    });

    it('steer() reports pending when no request-specific acknowledgment arrives', async () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });

      const result = await actions.steer('run-1', 'go this way');

      expect(result).toMatchObject({
        requestPath: expect.any(String),
        requestId: expect.any(String),
        index: 0,
        state: 'pending',
      });
    });

    it('steer() returns the exact matching child acknowledgment without consuming another request', async () => {
      class AckManagementActions extends ManagementActions {
        protected override readonly steerAckTimeoutMs = 500;
        protected override readonly steerAckPollIntervalMs = 5;
        protected override generateSteerRequestId(): string {
          return 'matching-request';
        }
      }
      const runIds = new FakeRunIdResolver();
      const runDir = makeRunDir();
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });
      const actions = new AckManagementActions(runIds, new FakeAsyncJobTracker());
      const pending = actions.steer('run-1', 'go this way', 2);
      writeSteerAck(runDir, {
        requestId: 'matching-request',
        index: 2,
        ts: Date.now(),
        state: 'delivered',
        message: 'Pi accepted this exact request.',
      });

      await expect(pending).resolves.toMatchObject({
        requestId: 'matching-request',
        index: 2,
        state: 'delivered',
        message: 'Pi accepted this exact request.',
      });
    });

    it('control inbox and steer dirs are the real ones control-channel.ts itself resolves', async () => {
      const { runIds, actions } = makeActions();
      const runDir = makeRunDir();
      runIds.locations.set('run-1', { runId: 'run-1', runDir, resultPath: undefined, claimed: false });

      actions.interrupt('run-1');
      await actions.steer('run-1', 'hello');

      expect(fs.existsSync(controlInboxDir(runDir))).toBe(true);
      expect(fs.existsSync(steerRequestsDir(runDir))).toBe(true);
    });
  });
});
