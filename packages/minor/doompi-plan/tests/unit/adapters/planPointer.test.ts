import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodePlanPointerAdapter } from '../../../src/adapters/node/planPointer.ts';

/**
 * The extension and the session's API server are separate processes that never
 * talk. They meet only here, on a record keyed by the session id both of them
 * hold, so what this pins is that a write on one side is readable from the
 * other given nothing but that id.
 */

const temporaries: string[] = [];

function homeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-plan-pointer-'));
  temporaries.push(directory);
  return directory;
}

/** The adapter as the other process would build it: same home, nothing shared. */
function adapterOn(home: string, env: NodeJS.ProcessEnv = {}): NodePlanPointerAdapter {
  return new NodePlanPointerAdapter({ homeDirectory: home, env });
}

afterEach(() => {
  while (temporaries.length > 0) fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe('the plan pointer', () => {
  it('reads back what the other half of the session wrote', () => {
    const home = homeDirectory();
    const record = { path: '/plans/a-plan--1.md', title: 'a-plan', writtenAt: '2026-08-27T00:00:00.000Z', planId: '1' };

    adapterOn(home).write('session-1', record);

    expect(adapterOn(home).read('session-1')).toEqual(record);
  });

  it('reports no plan for a session that has written none', () => {
    expect(adapterOn(homeDirectory()).read('session-1')).toBeUndefined();
  });

  it('keeps one session out of the record another session wrote', () => {
    const home = homeDirectory();
    const pointers = adapterOn(home);

    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });

    expect(pointers.read('session-2')).toBeUndefined();
  });

  it('overwrites the record when the plan is rewritten', () => {
    const home = homeDirectory();
    const pointers = adapterOn(home);

    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });
    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T01:00:00.000Z' });

    expect(pointers.read('session-1')?.writtenAt).toBe('2026-08-27T01:00:00.000Z');
  });

  it('forgets a session, and forgetting one twice is not an error', () => {
    const home = homeDirectory();
    const pointers = adapterOn(home);
    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });

    pointers.clear('session-1');
    pointers.clear('session-1');

    expect(pointers.read('session-1')).toBeUndefined();
  });

  it('follows PI_CODING_AGENT_DIR, which is where a configured session keeps its state', () => {
    const home = homeDirectory();
    const agentDirectory = homeDirectory();
    const pointers = adapterOn(home, { PI_CODING_AGENT_DIR: agentDirectory });

    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });

    expect(pointers.pathFor('session-1').startsWith(agentDirectory)).toBe(true);
    expect(adapterOn(home).read('session-1')).toBeUndefined();
  });

  it('keeps the record private, the way the plan file it points at is', () => {
    const home = homeDirectory();
    const pointers = adapterOn(home);

    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });

    expect(fs.statSync(pointers.pathFor('session-1')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pointers.directory()).mode & 0o777).toBe(0o700);
  });

  it('never puts a session id straight into a filename', () => {
    const pointers = adapterOn(homeDirectory());

    // A host words session ids however it likes, and a path separator inside
    // one would otherwise decide where the record lands.
    expect(path.dirname(pointers.pathFor('../../escape'))).toBe(pointers.directory());
  });

  it('reads a half-written record as no plan rather than as a broken one', () => {
    const home = homeDirectory();
    const pointers = adapterOn(home);
    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });
    fs.writeFileSync(pointers.pathFor('session-1'), '{"path":"/plans/one.md","title"');

    expect(pointers.read('session-1')).toBeUndefined();
  });

  it('refuses a record naming a relative path, which no other process could resolve', () => {
    const home = homeDirectory();
    const pointers = adapterOn(home);
    pointers.write('session-1', { path: '/plans/one.md', title: 'one', writtenAt: '2026-08-27T00:00:00.000Z' });
    fs.writeFileSync(pointers.pathFor('session-1'), JSON.stringify({ path: 'one.md', title: 'one', writtenAt: 'x' }));

    expect(pointers.read('session-1')).toBeUndefined();
  });
});
