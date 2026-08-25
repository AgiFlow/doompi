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

const JOURNAL_DIR_NAME = 'journals';

/** One journal line the way Pi's SessionManager writes a message entry. */
export function journalEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', id, parentId: null, timestamp: new Date().toISOString(), message };
}

/**
 * Writes a run's own Pi session journal, header first, and returns its path:
 * the value a run status carries as `sessionFile`. It lives under the same
 * session scope so removeRunsScope takes it away with the runs.
 */
export function writeRunJournal(sessionId: string, runId: string, entries: Array<Record<string, unknown>>): string {
  const dir = path.join(path.dirname(runsDirFor(sessionId)), JOURNAL_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.jsonl`);
  const header = { type: 'session', version: 1, id: runId, timestamp: new Date().toISOString(), cwd: '/workspace' };
  fs.writeFileSync(file, [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  return file;
}

/** Appends lines the way a live child session would, one whole entry at a time. */
export function appendRunJournal(file: string, entries: Array<Record<string, unknown>>): void {
  fs.appendFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

const AGENTS_DIR_NAME = 'agents';

/** Writes one agent definition under the hub's own Pi agent dir, where discovery reads user agents. */
export function writeAgentDefinition(agentDir: string, name: string, description: string): string {
  const dir = path.join(agentDir, AGENTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\nYou review code.\n`);
  return file;
}
