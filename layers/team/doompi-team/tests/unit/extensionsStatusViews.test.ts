import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { formatFleetView, formatRunTranscript } from '../../src/adapters/pi/extensions/statusViews';
import type { TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type { AsyncRunStatus } from '../../src/adapters/runs/background/asyncExecution';

const temporaryDirs: string[] = [];

function makeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-status-views-'));
  temporaryDirs.push(dir);
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return file;
}

function assistantLine(text: string): string {
  return JSON.stringify({ recordType: 'message', role: 'assistant', ts: 1, text });
}

function status(overrides: Partial<AsyncRunStatus> = {}): AsyncRunStatus {
  return {
    runId: 'run-1',
    agent: 'worker',
    state: 'running',
    startedAt: 0,
    lastUpdate: 0,
    nudgeTarget: { kind: 'broadcast' },
    ...overrides,
  } as AsyncRunStatus;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatFleetView', () => {
  const now = 60_000;

  function job(overrides: Partial<TrackedAsyncJob> = {}): TrackedAsyncJob {
    return { runId: 'run-1', status: 'running', startedAt: 0, ...overrides };
  }

  it('says so plainly when nothing is tracked, rather than rendering an empty list', () => {
    expect(formatFleetView([], now)).toMatch(/No runs tracked/);
  });

  it('lists each run with its id, so a follow-up call has something to address', () => {
    const text = formatFleetView([job({ runId: 'run-a' }), job({ runId: 'run-b' })], now);

    expect(text).toContain('run-a');
    expect(text).toContain('run-b');
    expect(text).toContain('2 active runs');
  });

  it('surfaces an attention state and its reason', () => {
    const text = formatFleetView(
      [job({ activityState: 'needs_attention', attentionReason: 'missing-deliverable' })],
      now,
    );

    expect(text).toContain('needs_attention');
    expect(text).toContain('missing-deliverable');
  });

  it('reports a run with no status yet as starting rather than as blank', () => {
    expect(formatFleetView([job({ status: undefined })], now)).toContain('starting');
  });

  it('tells the reader how to drill into one run', () => {
    expect(formatFleetView([job()], now)).toContain('transcriptLines: 80');
  });

  it('lists suspended work and gives an exact restore call when its Pi transcript exists', () => {
    const sessionFile = makeTranscript([]);
    const text = formatFleetView([], now, [
      {
        version: 1,
        runId: 'suspended-1',
        agent: 'explorer',
        runtime: 'pi',
        task: 'inspect the flow',
        cwd: '/work',
        sessionFile,
        suspendedAt: 1,
        reason: 'resume',
      },
    ]);

    expect(text).toContain('1 suspended run');
    expect(text).toContain('{ action: "restore", id: "suspended-1" }');
    expect(text).not.toContain('No runs tracked');
  });

  it('marks incomplete suspended records as not resumable', () => {
    const text = formatFleetView([], now, [
      {
        version: 1,
        runId: 'legacy-1',
        agent: 'explorer',
        runtime: 'pi',
        task: '',
        cwd: '/work',
        suspendedAt: 1,
        reason: 'parent_lost',
      },
    ]);

    expect(text).toContain('not resumable; submit a new explicit run');
  });
});

describe('formatRunTranscript', () => {
  it('explains the absence when artifacts were disabled, instead of looking like an empty run', () => {
    expect(formatRunTranscript(status(), 80)).toMatch(/artifacts were disabled/i);
  });

  it('explains the absence when the run has no status at all', () => {
    expect(formatRunTranscript(undefined, 80)).toMatch(/No status found/);
  });

  it('reports an unreadable transcript path rather than pretending the run was silent', () => {
    const text = formatRunTranscript(status({ transcriptPath: '/nonexistent/transcript.jsonl' }), 80);

    expect(text).toMatch(/could not be read/);
  });

  it('reports an empty transcript distinctly from a missing one', () => {
    const text = formatRunTranscript(status({ transcriptPath: makeTranscript([]) }), 80);

    expect(text).toMatch(/has not written anything yet/);
  });

  it('renders events as plain text, with no ANSI escapes for a model to pay for', () => {
    const transcriptPath = makeTranscript([assistantLine('hello there')]);

    const text = formatRunTranscript(status({ transcriptPath }), 80);

    expect(text).toContain('hello there');
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\[/);
  });

  it('tails from the END, because the recent lines are the useful ones', () => {
    const transcriptPath = makeTranscript(Array.from({ length: 10 }, (_, index) => assistantLine(`line ${index}`)));

    const text = formatRunTranscript(status({ transcriptPath }), 3);

    expect(text).toContain('line 9');
    expect(text).not.toContain('line 0');
  });

  it('states that it truncated, so a tail is never mistaken for the whole run', () => {
    const transcriptPath = makeTranscript(Array.from({ length: 10 }, (_, index) => assistantLine(`line ${index}`)));

    expect(formatRunTranscript(status({ transcriptPath }), 3)).toMatch(/earlier line\(s\) not shown/);
  });

  it('does not claim truncation when everything fits', () => {
    const transcriptPath = makeTranscript([assistantLine('only line')]);

    expect(formatRunTranscript(status({ transcriptPath }), 80)).not.toMatch(/not shown/);
  });
});
