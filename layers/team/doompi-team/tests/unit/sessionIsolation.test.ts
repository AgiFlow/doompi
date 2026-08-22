import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultWatcher, type RunResultFile } from '../../src/adapters/resultWatcher';
import {
  createSessionScope,
  type SessionScope,
  scopeResultsDir,
  scopeRunsDir,
  sessionScopeDir,
  setCurrentSessionScope,
} from '../../src/adapters/filesystem/paths';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';

/**
 * Two concurrent sessions must not see each other's state.
 *
 * WHY THIS IS A REAL-FILESYSTEM TEST AND NOT AN IN-MEMORY ONE:
 * The whole question is whether two independently-constructed watchers,
 * sharing one on-disk `RESULTS_DIR`, can take each other's work. An in-memory
 * fake (`runsBackgroundResultWatcher.test.ts`) gives each watcher its own
 * map, which is precisely the isolation under test - it would pass whether or
 * not the production layout is scoped, and prove nothing.
 *
 * WRITTEN BEFORE THE FIX, DELIBERATELY:
 * `ResultWatcher` claims a result by atomically renaming
 * `RESULTS_DIR/<runId>.json` into `RUNS_DIR/<runId>/claimed-result.json`, and
 * its consumer in `extensions/pi.ts` returns `false` - meaning "not delivered,
 * retry later", not "not mine" - for any run the current session does not
 * track. The suspicion is that a session can therefore win the claim race on a
 * run it does not own and then never deliver it. This test exists to settle
 * that before the scoping work is written, so the fix is aimed at a confirmed
 * failure rather than a plausible one.
 */

class FakeScheduler implements PollSchedulerContract {
  registered: PollSubscription | undefined;

  register(subscription: PollSubscription): () => void {
    this.registered = subscription;
    return () => {
      this.registered = undefined;
    };
  }
  wake(): void {}
  start(): void {}
  stop(): void {}
}

/**
 * A watcher standing in for one session, with the watch disabled so only the
 * explicit tick runs.
 *
 * Every filesystem call runs with this instance's own scope installed as the
 * process scope, which is what production does: one process serves one root
 * session at a time. Driving two in one test process means swapping the scope
 * per call rather than holding both at once.
 */
class SessionWatcher extends ResultWatcher {
  constructor(
    readonly scope: SessionScope,
    scheduler: FakeScheduler,
  ) {
    super(scheduler);
  }

  /** Run ids this "session" owns, mirroring `AsyncJobTracker.forSession(...)`. */
  readonly owned = new Set<string>();
  /** Results this session actually accepted. */
  readonly delivered: string[] = [];

  protected override watchResultsDir(): fs.FSWatcher | undefined {
    // Real OS watch events are not needed: every test drives `tick()` directly.
    return undefined;
  }

  /** The exact consumer shape `extensions/pi.ts` installs. */
  readonly sessionConsumer = (result: RunResultFile): boolean => {
    if (!this.owned.has(result.runId)) return false;
    this.delivered.push(result.runId);
    return true;
  };

  /** Poll once as this session, with its own scope active. */
  async tick(): Promise<boolean> {
    setCurrentSessionScope(this.scope);
    return (this as unknown as { run(): Promise<boolean> }).run();
  }

  begin(): void {
    setCurrentSessionScope(this.scope);
    this.start(this.sessionConsumer);
  }
}

const temporaryScopes: SessionScope[] = [];

function makeScope(label: string): SessionScope {
  const scope = createSessionScope(`session-isolation-${label}-${Math.random().toString(36).slice(2, 10)}`);
  temporaryScopes.push(scope);
  return scope;
}

function resultPath(scope: SessionScope, runId: string): string {
  return path.join(scopeResultsDir(scope), `${runId}.json`);
}

/** Write a terminal result into the scope that owns the run. */
function writeResultFor(scope: SessionScope, runId: string): void {
  fs.mkdirSync(scopeResultsDir(scope), { recursive: true });
  fs.writeFileSync(resultPath(scope, runId), JSON.stringify({ runId, summary: 'done' }));
}

function claimedResultExists(scope: SessionScope, runId: string): boolean {
  return fs.existsSync(path.join(scopeRunsDir(scope), runId, 'claimed-result.json'));
}

afterEach(() => {
  while (temporaryScopes.length > 0) {
    const scope = temporaryScopes.pop();
    if (scope) fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
  }
});

describe('two concurrent sessions', () => {
  it("does not let one session claim another session's result", async () => {
    const scopeA = makeScope('a');
    const scopeB = makeScope('b');
    const runId = 'run-owned-by-b';

    const sessionA = new SessionWatcher(scopeA, new FakeScheduler());
    const sessionB = new SessionWatcher(scopeB, new FakeScheduler());
    sessionB.owned.add(runId); // only B spawned this run
    sessionA.begin();
    sessionB.begin();

    writeResultFor(scopeB, runId);

    // A polls first, exactly as it would if its timer fired sooner.
    await sessionA.tick();
    await sessionB.tick();

    await expect.poll(() => sessionB.delivered).toEqual([runId]);
    expect(sessionA.delivered).toEqual([]);

    sessionA.stop();
    sessionB.stop();
  });

  it("leaves a foreign session's result file in place rather than taking it", async () => {
    const scopeA = makeScope('reader');
    const scopeB = makeScope('owner');
    const runId = 'run-untouched';

    const sessionA = new SessionWatcher(scopeA, new FakeScheduler());
    sessionA.begin(); // owns nothing

    writeResultFor(scopeB, runId);
    await sessionA.tick();

    // The file must still be where its real owner will look for it.
    expect(fs.existsSync(resultPath(scopeB, runId))).toBe(true);
    expect(claimedResultExists(scopeA, runId)).toBe(false);
    expect(claimedResultExists(scopeB, runId)).toBe(false);

    sessionA.stop();
  });
});
