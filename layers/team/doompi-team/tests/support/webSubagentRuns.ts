import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRunsDirFor } from '../../src/adapters/webSubagentWatcher.ts';
import { RUN_STATUS_FILE_NAME } from '../../src/services/webSubagentRuns.ts';

/** The runs directory the web hub channel watches for this session id. */
export function runsDirFor(sessionId: string): string {
  const dir = teamRunsDirFor({ sessionId, tmpdir: os.tmpdir(), uid: process.getuid?.() });
  if (dir === undefined) throw new Error('This platform has no uid to scope doom-team runs by.');
  return dir;
}

/** Writes one run status the way this package's status writer would. */
export function writeRunStatus(sessionId: string, status: Record<string, unknown>): void {
  const runDir = path.join(runsDirFor(sessionId), String(status.runId));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, RUN_STATUS_FILE_NAME), JSON.stringify(status));
}

/** Removes the whole scope a test polluted, session dir included. */
export function removeRunsScope(sessionId: string): void {
  fs.rmSync(path.dirname(runsDirFor(sessionId)), { recursive: true, force: true });
}
