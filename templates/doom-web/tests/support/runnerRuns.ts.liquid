import fs from 'node:fs';
import path from 'node:path';

// Self-contained mirror of doom-runner's per-session store layout: the e2e
// suite writes real metadata records the doompi-runner plugin's watcher
// reads, so this fixture depends on that package's disk contract, not on any
// source.
const STATE_DIR_NAME = 'runs';

export interface RunnerRecordFixture {
  id: string;
  name: string;
  command: string;
  /** Merged over the minimal valid running record; pass state, exit, etc. here. */
  record?: Record<string, unknown>;
}

/** Writes one runner record the way doom-runner's registry lays it out. */
export function writeRunnerRecord(storeDir: string, sessionId: string, fixture: RunnerRecordFixture): void {
  const stateDir = path.join(storeDir, sessionId, STATE_DIR_NAME);
  fs.mkdirSync(stateDir, { recursive: true });
  const record = {
    id: fixture.id,
    name: fixture.name,
    pid: 4242,
    command: fixture.command,
    cwd: '/workspace/doompi',
    logPath: path.join(storeDir, sessionId, 'logs', `${fixture.id}.log`),
    interactive: false,
    sessionId,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: process.pid,
    ...fixture.record,
  };
  fs.writeFileSync(path.join(stateDir, `${fixture.id}.json`), JSON.stringify(record));
}
