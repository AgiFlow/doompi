import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { currentRunsDir } from '../../src/adapters/filesystem/paths';
import { checkPidLiveness, ProcessTerminalInspector, type ProcessLiveness } from '../../src/adapters/processTerminal';

/** Overrides the pid probe seam so no test ever signals a real process. */
class TestProcessTerminalInspector extends ProcessTerminalInspector {
  livenessByPid = new Map<number, ProcessLiveness>();

  protected override probePid(pid: number): ProcessLiveness {
    return this.livenessByPid.get(pid) ?? 'unknown';
  }
}

const trackedRunDirs: string[] = [];

function makeRunId(label: string): string {
  const runId = `${label}-${randomUUID()}`;
  trackedRunDirs.push(path.join(currentRunsDir(), runId));
  return runId;
}

function crashMarkerPath(runId: string): string {
  return path.join(currentRunsDir(), runId, 'runner-crash-marker.json');
}

function writeCrashMarker(runId: string, pid: number, startedAt = Date.now()): void {
  fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
  fs.writeFileSync(crashMarkerPath(runId), JSON.stringify({ version: 1, runId, pid, startedAt }));
}

afterEach(() => {
  while (trackedRunDirs.length > 0) {
    const dir = trackedRunDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkPidLiveness', () => {
  it("reports 'alive' when the probe succeeds", () => {
    expect(checkPidLiveness(123, () => true)).toBe('alive');
  });

  it("reports 'dead' only for an OS-confirmed ESRCH", () => {
    const probe = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    expect(checkPidLiveness(123, probe)).toBe('dead');
  });

  it("reports 'unknown' for EPERM, since the process exists but ownership is unverifiable", () => {
    const probe = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    expect(checkPidLiveness(123, probe)).toBe('unknown');
  });

  it("reports 'unknown' for any other thrown error, never guessing 'dead' from it", () => {
    const probe = () => {
      throw new Error('something unrelated');
    };
    expect(checkPidLiveness(123, probe)).toBe('unknown');
  });
});

describe('ProcessTerminalInspector.inspect', () => {
  it("returns 'unknown' with no marker when the run has never had a crash marker written", () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('no-marker');

    expect(inspector.inspect(runId)).toEqual({ state: 'unknown', marker: undefined });
  });

  it("returns 'crashed' only when the marker's pid is OS-confirmed dead", () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('crashed');
    writeCrashMarker(runId, 4242, 1000);
    inspector.livenessByPid.set(4242, 'dead');

    expect(inspector.inspect(runId)).toEqual({
      state: 'crashed',
      marker: { version: 1, runId, pid: 4242, startedAt: 1000 },
    });
  });

  it("returns 'alive' when the marker's pid is genuinely still alive, and does not authorize a repair", () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('alive');
    writeCrashMarker(runId, 4242, 1000);
    inspector.livenessByPid.set(4242, 'alive');

    expect(inspector.inspect(runId)).toEqual({
      state: 'alive',
      marker: { version: 1, runId, pid: 4242, startedAt: 1000 },
    });
  });

  it("returns 'unknown' when the marker's pid liveness cannot be verified, not 'crashed'", () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('unknown-liveness');
    writeCrashMarker(runId, 4242, 1000);
    inspector.livenessByPid.set(4242, 'unknown');

    expect(inspector.inspect(runId)).toEqual({
      state: 'unknown',
      marker: { version: 1, runId, pid: 4242, startedAt: 1000 },
    });
  });

  it('treats a marker with the wrong version as no marker at all', () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('wrong-version');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
    fs.writeFileSync(crashMarkerPath(runId), JSON.stringify({ version: 2, runId, pid: 1, startedAt: 1 }));

    expect(inspector.inspect(runId)).toEqual({ state: 'unknown', marker: undefined });
  });

  it('treats a marker missing a required field as no marker at all', () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('missing-field');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
    fs.writeFileSync(crashMarkerPath(runId), JSON.stringify({ version: 1, runId }));

    expect(inspector.inspect(runId)).toEqual({ state: 'unknown', marker: undefined });
  });

  it('treats an unparseable marker (a torn read mid-write) as no marker at all, not a crash', () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('torn-read');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
    fs.writeFileSync(crashMarkerPath(runId), '{"version": 1, "pid": ');

    expect(inspector.inspect(runId)).toEqual({ state: 'unknown', marker: undefined });
  });

  it('treats a marker that is valid JSON but not an object as no marker at all', () => {
    const inspector = new TestProcessTerminalInspector();
    const runId = makeRunId('not-an-object');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
    fs.writeFileSync(crashMarkerPath(runId), JSON.stringify([1, 2, 3]));

    expect(inspector.inspect(runId)).toEqual({ state: 'unknown', marker: undefined });
  });
});

describe('ProcessTerminalInspector against the real pid probe', () => {
  it("confirms this test process's own pid as 'alive', exercising the real probe end to end", () => {
    const inspector = new ProcessTerminalInspector();
    const runId = makeRunId('real-probe-alive');
    writeCrashMarker(runId, process.pid, Date.now());

    expect(inspector.inspect(runId)).toEqual({
      state: 'alive',
      marker: expect.objectContaining({ pid: process.pid }),
    });
  });
});
