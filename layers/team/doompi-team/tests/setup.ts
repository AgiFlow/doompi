import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HARNESS_STATE_POINTER, resetHarnessStore } from '@agimon-ai/doompi-config';
import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { SUBAGENT_PARENT_DEPTH_ENV } from '../src/exports/env';

/**
 * Give every test worker its own OS temp root, before anything reads one.
 *
 * WHY: `src/shared/paths.ts` computes `TEMP_ROOT_DIR` once, at import time,
 * as `os.tmpdir()/doom-team-uid-<uid>` - a single path shared by every test
 * file, every concurrent worker, and every other doom-team process running as
 * the same user. `RESULTS_DIR`, `RUNS_DIR`, `SUPERVISOR_CHANNELS_DIR` and the
 * rest all hang off it.
 *
 * That made the suite flaky in a way that looked like broken code: whole-root
 * teardowns in one test file (`piArgs.test.ts` swept `SUPERVISOR_CHANNELS_DIR`)
 * raced files running concurrently in other workers, so 7-10 tests failed per
 * run with a DIFFERENT set of names each time, and `ENOTEMPTY` surfaced
 * occasionally. Each file passed in isolation.
 *
 * `os.tmpdir()` reads `TMPDIR`/`TEMP`/`TMP` on every call and does not cache,
 * and vitest evaluates setup files before the test module they support, so
 * pointing them at a fresh directory here relocates the entire tree per worker.
 * This is a test-harness fix on purpose: no production code changes to
 * accommodate tests, and it isolates every shared root at once rather than the
 * one directory that happened to be noticed.
 *
 * Do NOT "fix" this class of flake by serialising the shards. That hides the
 * shared state instead of removing it.
 */
// `realpathSync` because macOS reports /var/folders/... while the real path is
// /private/var/folders/...; several modules here compare resolved paths.
const workerTempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'doom-team-worker-'));
process.env.TMPDIR = workerTempRoot;
process.env.TEMP = workerTempRoot;
process.env.TMP = workerTempRoot;

process.once('exit', () => {
  try {
    fs.rmSync(workerTempRoot, { recursive: true, force: true });
  } catch (error) {
    // Best effort: a leftover directory under the OS temp dir is not worth
    // failing a test run over, and the OS reclaims it. Surfaced rather than
    // dropped so a worker that consistently cannot clean up is visible.
    //
    // `process.emitWarning`, not a logger service and not `console`: this file
    // is vitest's setup entry point, so it runs before any module or container
    // exists to inject a logger from, and it has no stdout contract of its own
    // to write to.
    process.emitWarning(
      `Could not remove worker temp root '${workerTempRoot}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

/**
 * Give every test a session scope, since the scoped path helpers throw without
 * one.
 *
 * In production the scope is adopted from `session_start` (parent) or the spawn
 * environment (child); neither happens in a unit test, and making every test
 * set one by hand would be noise. The id is per-worker so two workers cannot
 * collide on a scope directory, matching the temp-root isolation above.
 *
 * A test that specifically exercises cross-session behaviour overrides this
 * with its own scopes - see `tests/unit/sessionIsolation.test.ts`.
 *
 * DYNAMIC IMPORT, NOT A STATIC ONE, AND THAT IS LOAD-BEARING:
 * `shared/paths.ts` computes `TEMP_ROOT_DIR` from `os.tmpdir()` at import time.
 * ESM hoists static imports above every statement in this file, so importing it
 * at the top would evaluate that constant BEFORE the `TMPDIR` reassignment
 * above - silently undoing the per-worker isolation this whole file exists for
 * and putting every worker back on one shared tree.
 */
const { createSessionScope, setCurrentSessionScope } = await import('../src/adapters/filesystem/paths');
setCurrentSessionScope(createSessionScope(`test-worker-${process.pid}`));

// Global test setup
beforeAll(async () => {
  // Initialize test environment
  vi.clearAllMocks();
});

afterAll(async () => {
  // Cleanup after all tests
  vi.resetAllMocks();
});

beforeEach(() => {
  // Unit tests must not inherit the parent Pi process's persisted harness or
  // subagent depth. Individual cases arrange either value when it is relevant.
  process.env[HARNESS_STATE_POINTER] = '';
  process.env[SUBAGENT_PARENT_DEPTH_ENV] = '0';
  resetHarnessStore();
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.clearAllMocks();
});
