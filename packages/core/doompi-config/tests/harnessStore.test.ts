import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_STATE_KEYS, readHarnessState } from '../src/adapters/harnessState.ts';
import {
  createHarnessSession,
  getHarnessState,
  HARNESS_STATE_POINTER,
  resetHarnessStore,
  updateHarnessState,
} from '../src/adapters/harnessStore.ts';

const TRACKED_KEYS = [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)];

let workDir: string;
let savedEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-harness-store-'));
  savedEnvironment = Object.fromEntries(TRACKED_KEYS.map((key) => [key, process.env[key]]));
  resetHarnessStore();
});

afterEach(() => {
  resetHarnessStore();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Writes a state file the way another copy of this package would. */
function rewriteAsOtherCopy(filePath: string, domains: string[]): void {
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { state: { domains: string[] } };
  file.state.domains = domains;
  fs.writeFileSync(filePath, JSON.stringify(file));
  // Same-millisecond rewrites would look unchanged; push the clock so the test
  // exercises the check rather than the filesystem's timestamp resolution.
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(filePath, future, future);
}

describe('the harness store across package copies', () => {
  it('serves a rewrite of its own file instead of the cached read', () => {
    const state = { ...readHarnessState({}), root: workDir, domains: ['default'] };
    const filePath = createHarnessSession(state, { directory: workDir, environment: process.env });
    expect(getHarnessState().domains).toEqual(['default']);

    rewriteAsOtherCopy(filePath, ['default', 'blog']);
    expect(getHarnessState().domains).toEqual(['default', 'blog']);
  });

  it('follows the pointer when another copy adopts a file of its own', () => {
    const state = { ...readHarnessState({}), root: workDir, domains: ['default'] };
    createHarnessSession(state, { directory: workDir, environment: process.env });
    expect(getHarnessState().domains).toEqual(['default']);

    const adopted = path.join(workDir, 'adopted', 'harness-state.json');
    createHarnessSession({ ...state, domains: ['development'] }, { directory: path.dirname(adopted), environment: {} });
    process.env[HARNESS_STATE_POINTER] = adopted;
    expect(getHarnessState().domains).toEqual(['development']);
  });

  it('still answers from memory while nothing moved', () => {
    const state = { ...readHarnessState({}), root: workDir, domains: ['default'] };
    createHarnessSession(state, { directory: workDir, environment: process.env });
    const first = getHarnessState();
    expect(getHarnessState()).toBe(first);

    updateHarnessState({ domains: ['testing'] });
    expect(getHarnessState().domains).toEqual(['testing']);
  });
});
