import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsyncRunStatus } from '../../src/adapters/runs/background/asyncExecution';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import { readAsyncRunStatus } from '../../src/adapters/statusReader';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';
import { collectFleetSnapshot, SubagentFleetComponent } from '../../src/adapters/pi/tui/fleet';
import { readFleetTranscriptTail } from '../../src/adapters/pi/tui/fleetTranscript';

/**
 * `fleet.ts`'s cache is keyed on the transcript file's disk fingerprint
 * (size+mtime), which real `fs` provides deterministically. What this suite
 * needs to isolate is a narrower claim - that a poll tick alone never forces
 * a re-parse - so the transcript READER is wrapped (module-level, ESM cannot
 * redefine `node:fs`'s own exports).
 *
 * The reader now RESUMES rather than re-reading, so a bare call count no
 * longer distinguishes cheap from expensive: the overlay calls it on every
 * paint and it early-returns when nothing was appended. The signal is instead
 * the `previous` argument - a call carrying one continues an existing parse,
 * a call without one re-parses the file from byte zero. The wrapper keeps the
 * real implementation so those calls do real work.
 */
vi.mock('../../src/adapters/pi/tui/fleetTranscript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/pi/tui/fleetTranscript')>();
  return {
    ...actual,
    readFleetTranscriptTail: vi.fn(actual.readFleetTranscriptTail),
  };
});

/** Calls that re-parsed from byte zero, i.e. the ones a cache is supposed to prevent. */
function fullReadCount(): number {
  return vi.mocked(readFleetTranscriptTail).mock.calls.filter((call) => call[1] === undefined).length;
}

vi.mock('../../src/adapters/statusReader', () => ({
  readAsyncRunStatus: vi.fn(),
}));

/** Captures whatever the component registers, and lets a test drive ticks by hand. */
class FakeScheduler implements PollSchedulerContract {
  registered: PollSubscription | undefined;
  unregisterCalls = 0;

  register(subscription: PollSubscription): () => void {
    this.registered = subscription;
    return () => {
      this.unregisterCalls += 1;
      this.registered = undefined;
    };
  }

  wake(): void {}
  start(): void {}
  stop(): void {}
}

/** In-memory stand-in: a test sets `jobs` directly rather than touching disk. */
class FakeTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  jobs: TrackedAsyncJob[] = [];

  track(): void {}
  untrack(): void {}
  list(): TrackedAsyncJob[] {
    return this.jobs;
  }
  get(runId: string): TrackedAsyncJob | undefined {
    return this.jobs.find((job) => job.runId === runId);
  }
  reset(): void {
    this.jobs = [];
  }
  start(): void {}
  stop(): void {}
}

function job(runId: string, overrides: Partial<TrackedAsyncJob> = {}): TrackedAsyncJob {
  return { runId, status: 'running', startedAt: 0, updatedAt: 0, ...overrides };
}

function runStatus(overrides: Partial<AsyncRunStatus> = {}): AsyncRunStatus {
  return {
    runId: 'run-a',
    agent: 'worker',
    state: 'running',
    startedAt: 0,
    lastUpdate: 0,
    ...overrides,
  };
}

class FakeTui {
  rendered = 0;
  /** Tall enough that the fixed detail header (fields + controls) always fits the body budget. */
  terminal = { rows: 80 };
  requestRender(): void {
    this.rendered += 1;
  }
}

describe('collectFleetSnapshot', () => {
  it('maps every tracked job to a named roster item in tracker order', () => {
    const tracker = new FakeTracker();
    tracker.jobs = [
      job('run-a', { agent: 'researcher', updatedAt: 100 }),
      job('run-b', { agent: 'package-dev', updatedAt: 200 }),
    ];
    const snapshot = collectFleetSnapshot(tracker);
    expect(snapshot.items.map((item) => [item.runId, item.agent])).toEqual([
      ['run-a', 'researcher'],
      ['run-b', 'package-dev'],
    ]);
  });

  it('keeps roster order stable when activity timestamps change between refreshes', () => {
    const tracker = new FakeTracker();
    tracker.jobs = [job('run-a', { updatedAt: 100 }), job('run-b', { updatedAt: 200 })];
    const initialOrder = collectFleetSnapshot(tracker).items.map((item) => item.runId);

    tracker.jobs = [job('run-a', { updatedAt: 300 }), job('run-b', { updatedAt: 200 })];
    const refreshedOrder = collectFleetSnapshot(tracker).items.map((item) => item.runId);

    expect(refreshedOrder).toEqual(initialOrder);
  });

  it('falls back to a short run id while the agent name is unavailable', () => {
    const tracker = new FakeTracker();
    tracker.jobs = [job('1234567890')];

    expect(collectFleetSnapshot(tracker).items[0]?.agent).toBe('12345678');
  });
});

describe('SubagentFleetComponent scheduler subscription', () => {
  let scheduler: FakeScheduler;
  let tracker: FakeTracker;
  let tui: FakeTui;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduler = new FakeScheduler();
    tracker = new FakeTracker();
    tui = new FakeTui();
    vi.mocked(readAsyncRunStatus).mockReturnValue(runStatus({ transcriptPath: '/tmp/run-a-transcript.jsonl' }));
  });

  it('registers with the poll scheduler instead of owning its own timer', () => {
    tracker.jobs = [job('run-a')];
    new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    expect(scheduler.registered).toBeDefined();
    expect(scheduler.registered?.id).toBe('tui-fleet');
  });

  it('THE FIX: a tick where the roster did not change reports no work and does not re-render', () => {
    tracker.jobs = [job('run-a', { updatedAt: 100 })];
    new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    const renderCountAfterConstruct = tui.rendered;

    // Nothing about the tracked job changed between this tick and the last.
    const worked = scheduler.registered?.run();

    expect(worked).toBe(false);
    expect(tui.rendered).toBe(renderCountAfterConstruct);
  });

  it('a tick where the roster changed reports work and requests a render', () => {
    tracker.jobs = [job('run-a', { updatedAt: 100, status: 'running' })];
    new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    const renderCountAfterConstruct = tui.rendered;

    tracker.jobs = [job('run-a', { updatedAt: 200, status: 'complete' })];
    const worked = scheduler.registered?.run();

    expect(worked).toBe(true);
    expect(tui.rendered).toBe(renderCountAfterConstruct + 1);
  });

  it('unregisters from the scheduler on dispose, rather than leaving a stale subscription', () => {
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.dispose();
    expect(scheduler.unregisterCalls).toBe(1);
    expect(scheduler.registered).toBeUndefined();
  });
});

describe('SubagentFleetComponent transcript cache', () => {
  let scheduler: FakeScheduler;
  let tracker: FakeTracker;
  let tui: FakeTui;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduler = new FakeScheduler();
    tracker = new FakeTracker();
    tui = new FakeTui();
    tracker.jobs = [job('run-a', { updatedAt: 100 })];
    vi.mocked(readAsyncRunStatus).mockReturnValue(runStatus({ transcriptPath: '/tmp/run-a-transcript.jsonl' }));
  });

  it('THE FIX: a poll tick with an unchanged roster does not clear the transcript cache, so a second render does not re-parse the transcript', async () => {
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.render(80);
    const fullReadsAfterFirstRender = fullReadCount();

    // Simulate several idle ticks - the predecessor's bug nulled the cache on
    // every one of these regardless of whether anything changed.
    await scheduler.registered?.run();
    await scheduler.registered?.run();
    component.render(80);

    expect(fullReadCount()).toBe(fullReadsAfterFirstRender);
  });

  it('resumes rather than re-parsing when the selected transcript grows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-fleet-'));
    const transcriptPath = path.join(directory, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{"recordType":"message","role":"user","text":"first","ts":1}\n');
    vi.mocked(readAsyncRunStatus).mockReturnValue(runStatus({ transcriptPath }));

    try {
      const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
      component.render(80);
      const fullReadsAfterFirstRender = fullReadCount();
      const rendersBeforeAppend = tui.rendered;

      fs.appendFileSync(transcriptPath, '{"recordType":"message","role":"user","text":"next","ts":2}\n');
      expect(scheduler.registered?.run()).toBe(true);
      expect(tui.rendered).toBe(rendersBeforeAppend + 1);

      const rendered = component.render(80).join('\n');
      // The appended record is picked up, and picking it up did not cost a
      // re-parse of what was already read.
      expect(rendered).toContain('next');
      expect(fullReadCount()).toBe(fullReadsAfterFirstRender);
      expect(scheduler.registered?.run()).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('Ctrl+R is still a deliberate, manual cache-clearing path', () => {
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.render(80);
    const fullReadsAfterFirstRender = fullReadCount();

    component.handleInput('\x12'); // Ctrl+R
    component.render(80);

    expect(fullReadCount()).toBeGreaterThan(fullReadsAfterFirstRender);
  });
});

describe('SubagentFleetComponent render and interaction', () => {
  let scheduler: FakeScheduler;
  let tracker: FakeTracker;
  let tui: FakeTui;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduler = new FakeScheduler();
    tracker = new FakeTracker();
    tui = new FakeTui();
    vi.mocked(readAsyncRunStatus).mockReturnValue(runStatus({ transcriptPath: '/tmp/run-a-transcript.jsonl' }));
  });

  it('uses a full-height narrow layout below 36 columns', () => {
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    const lines = component.render(20);
    expect(lines).toHaveLength(80);
    expect(lines.join('\n')).toContain('AGENT RUNS');
  });

  it('renders the named, instance-colored roster, detail fields, and controls for a selected run', () => {
    const colors: Array<{ color: string; text: string }> = [];
    const theme = {
      fg: (color: string, text: string) => {
        colors.push({ color, text });
        return text;
      },
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
    } as never;
    tracker.jobs = [job('run-a', { agent: 'package-dev', updatedAt: 100, status: 'running' })];
    const component = new SubagentFleetComponent(tui, theme, scheduler, tracker, () => {});
    const rendered = component.render(100).join('\n');
    expect(rendered).toContain('package-dev');
    expect(rendered).toContain('run-a'.slice(0, 8));
    expect(colors).toContainEqual({ color: agentIdentityColor('run-a'), text: 'package-dev' });
    expect(rendered).toContain('interrupt');
    // The one hint that survived the controls collapsing to a single line.
    expect(rendered).toContain('stop (run, final)');
  });

  it('renders each roster row as a name line over its state and age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    tracker.jobs = [
      job('run-a', { agent: 'package-dev', status: 'running', startedAt: 0, updatedAt: 30_000 }),
      job('run-b', { agent: 'reviewer', status: 'complete', startedAt: 1000, updatedAt: 61_000 }),
    ];
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});

    const roster = component.render(100).map((line) => line.slice(0, 40));
    vi.useRealTimers();

    const live = roster.findIndex((line) => line.includes('package-dev'));
    expect(live).toBeGreaterThanOrEqual(0);
    expect(roster[live]).not.toContain('running');
    // A live run is aged to now; a finished one to its last status write.
    expect(roster[live + 1]).toContain('running · 1m30s');
    const done = roster.findIndex((line) => line.includes('reviewer'));
    expect(roster[done + 1]).toContain('complete · 1m0s');
  });

  it('shows what the run is doing now, not just that it exists', () => {
    tracker.jobs = [job('run-a', { agent: 'package-dev', status: 'running' })];
    vi.mocked(readAsyncRunStatus).mockReturnValue(
      runStatus({
        transcriptPath: '/tmp/run-a-transcript.jsonl',
        activityState: 'working',
        currentTool: 'grep',
        toolCount: 23,
        tokens: 41200,
      }),
    );
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});

    const rendered = component.render(100).join('\n');

    expect(rendered).toContain('working');
    expect(rendered).toContain('grep');
    expect(rendered).toContain('23 tools');
    expect(rendered).toContain('41k tokens');
  });

  it('p swaps the detail pane to the agent tab and back', () => {
    tracker.jobs = [job('run-a', { agent: 'package-dev' })];
    vi.mocked(readAsyncRunStatus).mockReturnValue(
      runStatus({ transcriptPath: '/tmp/run-a-transcript.jsonl', cwd: '/repo', task: 'do the thing' }),
    );
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.render(100);

    component.handleInput('p');
    const agentTab = component.render(100).join('\n');
    expect(agentTab).toContain('SYSTEM PROMPT');
    expect(agentTab).toContain('do the thing');

    component.handleInput('p');
    expect(component.render(100).join('\n')).not.toContain('SYSTEM PROMPT');
  });

  it('says a system prompt was not recorded rather than showing a plausible guess', () => {
    tracker.jobs = [job('run-a')];
    vi.mocked(readAsyncRunStatus).mockReturnValue(runStatus({ transcriptPath: '/tmp/run-a-transcript.jsonl' }));
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.handleInput('p');

    expect(component.render(100).join('\n')).toContain('No system prompt was recorded');
  });

  it('uses the canonical list and detail legends in full and compact chrome', () => {
    tracker.jobs = [job('run-a')];
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    const full = component.render(200).join('\n');
    tui.terminal.rows = 5;
    const compact = component.render(200).join('\n');

    for (const rendered of [full, compact]) {
      expect(rendered).toContain('↑↓');
      expect(rendered).toContain('JK');
      expect(rendered).not.toContain('↑↓/jk');
      expect(rendered).not.toContain('J/K');
    }
  });

  it('renders the empty-roster fallback when nothing is tracked', () => {
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    const rendered = component.render(100).join('\n');
    expect(rendered).toContain('No tracked runs');
  });

  it('renders an artifacts-disabled empty state without reading a guessed transcript path', () => {
    tracker.jobs = [job('run-a', { status: 'failed' })];
    vi.mocked(readAsyncRunStatus).mockReturnValue(
      runStatus({ state: 'failed', error: 'Interrupted before completion.' }),
    );
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});

    const rendered = component.render(100).join('\n');

    expect(rendered).toContain('Transcript unavailable');
    expect(rendered).toContain('Artifacts were disabled');
    expect(rendered).not.toContain('ENOENT');
    expect(readFleetTranscriptTail).not.toHaveBeenCalled();
  });

  it('renders a neutral empty state when a persisted transcript path is unreadable', () => {
    tracker.jobs = [job('run-a', { status: 'failed' })];
    vi.mocked(readAsyncRunStatus).mockReturnValue(
      runStatus({ state: 'failed', transcriptPath: '/tmp/missing-transcript.jsonl' }),
    );
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});

    const rendered = component.render(100).join('\n');

    expect(rendered).toContain('Transcript unavailable');
    expect(rendered).toContain('artifact is missing');
    expect(rendered).toContain('or unreadable');
    expect(rendered).not.toContain('ENOENT');
  });

  it('moving selection with j/k updates which run is highlighted', () => {
    tracker.jobs = [job('run-a', { updatedAt: 200 }), job('run-b', { updatedAt: 100 })];
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.render(100);
    const renderCountBefore = tui.rendered;
    component.handleInput('j');
    expect(tui.rendered).toBeGreaterThan(renderCountBefore);
  });

  it('an unavailable control shows why, rather than silently doing nothing', () => {
    tracker.jobs = [job('run-a', { status: 'complete' })];
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.render(100);
    component.handleInput('i'); // interrupt: unavailable once complete
    const rendered = component.render(100).join('\n');
    expect(rendered).toContain('interrupt unavailable');
  });

  it('dispatches an available control through the injected dispatcher and reports the result', async () => {
    tracker.jobs = [job('run-a', { status: 'running' })];
    const dispatchAction = vi.fn().mockResolvedValue({ status: 'stopped' });
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {}, { dispatchAction });
    component.render(100);
    component.handleInput('x'); // stop
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchAction).toHaveBeenCalledWith({ action: 'stop', id: 'run-a' });
    const rendered = component.render(100).join('\n');
    expect(rendered).toContain('stopped');
  });

  it('closes the overlay on Escape', () => {
    const done = vi.fn();
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, done);
    component.handleInput('\x1b');
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('a steer draft composes text and submits it as a steer request', async () => {
    tracker.jobs = [job('run-a', { status: 'running' })];
    const dispatchAction = vi.fn().mockResolvedValue({ status: 'delivered' });
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {}, { dispatchAction });
    component.render(100);
    component.handleInput('m'); // steer
    component.handleInput('h');
    component.handleInput('i');
    component.handleInput('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchAction).toHaveBeenCalledWith({ action: 'steer', id: 'run-a', message: 'hi' });
  });

  it('invalidate() clears the transcript cache, the same as Ctrl+R', () => {
    tracker.jobs = [job('run-a')];
    const component = new SubagentFleetComponent(tui, fakeTheme(), scheduler, tracker, () => {});
    component.render(100);
    const fullReadsAfterFirstRender = fullReadCount();
    component.invalidate();
    component.render(100);
    expect(fullReadCount()).toBeGreaterThan(fullReadsAfterFirstRender);
  });
});

function fakeTheme() {
  const identity = (_color: string, text: string) => text;
  return {
    fg: identity,
    bg: identity,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  } as never;
}
