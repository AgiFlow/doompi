import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Self-contained mirror of doom-team's per-session runs layout: the e2e
// suite writes real status files the doompi-team plugin's watcher reads, so
// this fixture depends on that package's disk contract, not on any source.
const TEMP_ROOT_PREFIX = 'doom-team';
const SCOPE_KEY_HASH_LENGTH = 16;
const RUN_STATUS_FILE_NAME = 'status.json';

/** The doom-team runs directory a hub will watch for this session id. */
export function runsDirFor(sessionId: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('This platform has no uid to scope doom-team runs by.');
  const scopeKey = createHash('sha256').update(sessionId.trim()).digest('hex').slice(0, SCOPE_KEY_HASH_LENGTH);
  return path.join(os.tmpdir(), `${TEMP_ROOT_PREFIX}-uid-${String(uid)}`, 'sessions', scopeKey, 'runs');
}

/** Writes one run status the way doom-team's status writer would. */
export function writeRunStatus(sessionId: string, status: Record<string, unknown>): void {
  const runDir = path.join(runsDirFor(sessionId), String(status.runId));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, RUN_STATUS_FILE_NAME), JSON.stringify(status));
}

/** Removes the whole scope a test polluted, session dir included. */
export function removeRunsScope(sessionId: string): void {
  fs.rmSync(path.dirname(runsDirFor(sessionId)), { recursive: true, force: true });
}
