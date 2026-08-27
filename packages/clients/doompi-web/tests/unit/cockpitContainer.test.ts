import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CockpitContainerHarnessModule,
  CockpitContainerRequest,
} from '@agimon-ai/doompi-extension-contracts/cockpit-container';
import { createCockpitContainer } from '../../src/adapters/cockpitContainer.ts';

const ID_FILE = 'cockpit-container.json';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let stateDir: string;
let notices: string[];
let requests: CockpitContainerRequest[];
let reaped: string[];
let stops: number;
let now: number;
let alive: boolean;

/** Stands in for the sandbox layer, so no test ever asks for a container engine. */
function harness(overrides: Partial<CockpitContainerHarnessModule> = {}): CockpitContainerHarnessModule {
  return {
    startCockpitContainer: async (request) => {
      requests.push(request);
      return {
        ok: true,
        handle: {
          containerId: 'abc123',
          stop: async () => {
            stops += 1;
          },
          alive: async () => alive,
        },
      };
    },
    reapCockpitContainer: async (containerId) => {
      reaped.push(containerId);
      return true;
    },
    ...overrides,
  };
}

function open(module?: CockpitContainerHarnessModule) {
  return createCockpitContainer({
    stateDir,
    onNotice: (message) => notices.push(message),
    now: () => now,
    supervisePollMs: 1,
    resolveHarness: async () => module,
  });
}

function recordFile(): { containerId?: unknown; startedAt?: unknown } {
  return JSON.parse(fs.readFileSync(path.join(stateDir, ID_FILE), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-cockpit-container-'));
  notices = [];
  requests = [];
  reaped = [];
  stops = 0;
  now = 1_700_000_000_000;
  alive = true;
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.removeAllListeners('exit');
});

describe('starting the container', () => {
  it('passes the workspaces and the port through to the harness', async () => {
    const started = await open(harness()).start({ workspaces: [{ path: '/repo' }], port: 4173 });
    expect(started.ok).toBe(true);
    expect(requests[0]?.workspaces).toEqual([{ path: '/repo' }]);
    expect(requests[0]?.port).toBe(4173);
  });

  it('records the container id, so a killed process can still be cleaned up after', async () => {
    await open(harness()).start({ workspaces: [], port: 4173 });
    expect(recordFile()).toEqual({ containerId: 'abc123', startedAt: now });
  });

  it('writes that record where only this user can read it', async () => {
    await open(harness()).start({ workspaces: [], port: 4173 });
    // eslint-disable-next-line no-bitwise -- the mode bits are the assertion.
    expect(fs.statSync(path.join(stateDir, ID_FILE)).mode & 0o777).toBe(0o600);
  });

  it('forwards build progress to the caller', async () => {
    const seen: string[] = [];
    await open(
      harness({
        startCockpitContainer: async (request) => {
          request.onProgress?.('building');
          return { ok: true, handle: { containerId: 'x', stop: async () => {}, alive: async () => true } };
        },
      }),
    ).start({ workspaces: [], port: 1, onProgress: (message) => seen.push(message) });
    expect(seen).toEqual(['building']);
  });

  it('reports a harness that could not start it, and records nothing', async () => {
    const outcome = await open(
      harness({ startCockpitContainer: async () => ({ ok: false, error: 'no engine' }) }),
    ).start({ workspaces: [], port: 1 });
    expect(outcome).toEqual({ ok: false, error: 'no engine' });
    expect(fs.existsSync(path.join(stateDir, ID_FILE))).toBe(false);
  });

  it('starts without a notice channel or a clock, which is how a launcher builds it', async () => {
    const plain = createCockpitContainer({ stateDir, resolveHarness: async () => harness() });
    const started = await plain.start({ workspaces: [], port: 1 });
    expect(started.ok).toBe(true);
    expect(recordFile().containerId).toBe('abc123');
    if (!started.ok) return;
    await started.container.stop();
  });

  it('comes up anyway when the record cannot be written, since the reaper is only a net', async () => {
    const outcome = await createCockpitContainer({
      stateDir: path.join(stateDir, 'file-not-a-directory'),
      resolveHarness: async () => harness(),
    }).start({ workspaces: [], port: 1 });
    expect(outcome.ok).toBe(true);
  });

  it('says so plainly when no layer can host a container at all', async () => {
    const outcome = await open().start({ workspaces: [], port: 1 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('doompi-sandbox');
  });

  it('has nothing to reap when no layer can host a container', async () => {
    fs.writeFileSync(path.join(stateDir, ID_FILE), JSON.stringify({ containerId: 'orphan', startedAt: now }));
    await open().reapStale();
    expect(reaped).toEqual([]);
  });
});

describe('stopping the container', () => {
  it('stops it once, however many times it is asked', async () => {
    const started = await open(harness()).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    await started.container.stop();
    await started.container.stop();
    expect(stops).toBe(1);
  });

  it('clears the record, so the next start does not chase a container that is gone', async () => {
    const started = await open(harness()).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    await started.container.stop();
    expect(fs.existsSync(path.join(stateDir, ID_FILE))).toBe(false);
  });

  it('reports a stop that failed rather than pretending the container is gone', async () => {
    const started = await open(
      harness({
        startCockpitContainer: async () => ({
          ok: true,
          handle: {
            containerId: 'abc123',
            stop: async () => {
              throw new Error('daemon unreachable');
            },
            alive: async () => true,
          },
        }),
      }),
    ).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    await started.container.stop();
    expect(notices.some((message) => message.includes('daemon unreachable'))).toBe(true);
  });
});

describe('supervising it', () => {
  it('holds this process open for as long as the container runs', async () => {
    // Without this the supervisor's event loop empties the moment its server
    // closes, and the container is left with nobody to stop it.
    const started = await open(harness()).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    let settled = false;
    const watching = started.container.supervise().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    alive = false;
    await watching;
    expect(settled).toBe(true);
  });

  it('says so and clears the record when the container stops on its own', async () => {
    const started = await open(harness()).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    alive = false;
    await started.container.supervise();
    expect(notices.some((message) => message.includes('stopped on its own'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, ID_FILE))).toBe(false);
  });

  it('does not try to stop a container that already went away', async () => {
    const started = await open(harness()).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    alive = false;
    await started.container.supervise();
    await started.container.stop();
    expect(stops).toBe(0);
  });

  it('returns at once when the container was already stopped', async () => {
    const started = await open(harness()).start({ workspaces: [], port: 1 });
    if (!started.ok) throw new Error('start failed');
    await started.container.stop();
    await started.container.supervise();
    expect(stops).toBe(1);
  });
});

describe('reaping what an earlier process left behind', () => {
  it('does nothing when there is no record, which is the normal case', async () => {
    await open(harness()).reapStale();
    expect(reaped).toEqual([]);
  });

  it('stops the container the record names', async () => {
    fs.writeFileSync(path.join(stateDir, ID_FILE), JSON.stringify({ containerId: 'orphan', startedAt: now }));
    await open(harness()).reapStale();
    expect(reaped).toEqual(['orphan']);
    expect(notices.some((message) => message.includes('orphan'))).toBe(true);
  });

  it('removes the record even when the harness reports nothing to stop', async () => {
    fs.writeFileSync(path.join(stateDir, ID_FILE), JSON.stringify({ containerId: 'gone', startedAt: now }));
    await open(harness({ reapCockpitContainer: async () => false })).reapStale();
    expect(fs.existsSync(path.join(stateDir, ID_FILE))).toBe(false);
    expect(notices).toEqual([]);
  });

  it('ignores a record old enough that the id probably names something else now', async () => {
    fs.writeFileSync(path.join(stateDir, ID_FILE), JSON.stringify({ containerId: 'ancient', startedAt: now }));
    now += WEEK_MS + 1;
    await open(harness()).reapStale();
    expect(reaped).toEqual([]);
  });

  it('ignores a record it cannot make sense of', async () => {
    fs.writeFileSync(path.join(stateDir, ID_FILE), 'not json');
    await open(harness()).reapStale();
    expect(reaped).toEqual([]);
  });

  it('ignores a record with no container id in it', async () => {
    fs.writeFileSync(path.join(stateDir, ID_FILE), JSON.stringify({ startedAt: now }));
    await open(harness()).reapStale();
    expect(reaped).toEqual([]);
  });
});
