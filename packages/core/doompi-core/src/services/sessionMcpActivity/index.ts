import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SessionMcpCall, SessionMcpInvocation } from '../../schemas/sessionMcpActivity';

const PREVIEW_LIMIT = 16_384;
const PAGE_SIZE = 50;
const SECRET_KEY = /password|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key/iu;

/** Bounded text previews only. Do not persist binary MCP content or authentication material. */
export function sessionMcpPreview(value: unknown): string {
  let remaining = PREVIEW_LIMIT;
  const seen = new WeakSet<object>();
  const clean = (item: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 12) return '[truncated]';
    if (typeof item === 'string') {
      const text = item
        .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted]')
        .replace(/([?&](?:token|api_key|key|secret|password)=)[^&#\s"']*/giu, '$1[redacted]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@');
      const bounded = text.slice(0, remaining);
      remaining -= bounded.length;
      return bounded.length < text.length ? `${bounded}\n[truncated]` : bounded;
    }
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 100).map((entry) => clean(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          SECRET_KEY.test(key)
            ? '[redacted]'
            : key === 'data' && typeof entry === 'string'
              ? '[binary omitted]'
              : clean(entry, depth + 1),
        ]),
    );
  };
  try {
    const text = JSON.stringify(clean(value, 0), null, 2) ?? '';
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n[truncated]` : text;
  } catch {
    return '[preview unavailable]';
  }
}

/** One process owns this private ledger. Pagination never drops older tool calls. */
export function createSessionMcpActivityStore(stateDir: string) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'session-mcp-activity.sqlite');
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS calls (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS calls_session ON calls(workspace_id, session_id, sequence);
  `);
  // A process restart cannot truthfully keep an in-flight call marked as running.
  const unfinished = database
    .prepare("SELECT id, record FROM calls WHERE json_extract(record, '$.status') = 'running'")
    .all();
  const update = database.prepare('UPDATE calls SET record = ? WHERE id = ?');
  for (const row of unfinished) {
    const record = JSON.parse(String(row.record)) as SessionMcpCall;
    update.run(JSON.stringify({ ...record, status: 'interrupted', finishedAt: Date.now() }), String(row.id));
  }
  let failure: Error | undefined;
  const save = database.prepare(`
    INSERT INTO calls (id, workspace_id, session_id, record) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, session_id = excluded.session_id, record = excluded.record
  `);
  return {
    record(workspaceId: string, sessionId: string, clientName: string, invocation: SessionMcpInvocation): void {
      try {
        const record: Omit<SessionMcpCall, 'sequence'> = {
          id: invocation.id,
          toolName: invocation.toolName,
          clientName,
          startedAt: invocation.startedAt,
          finishedAt: invocation.finishedAt,
          status: invocation.status,
          input: sessionMcpPreview(invocation.input),
          ...(invocation.output === undefined ? {} : { output: sessionMcpPreview(invocation.output) }),
        };
        save.run(invocation.id, workspaceId, sessionId, JSON.stringify(record));
      } catch (error) {
        failure = new Error('MCP call history could not be saved. Check the host storage.', { cause: error });
        throw failure;
      }
    },
    read(workspaceId: string, sessionId: string, before?: number) {
      if (failure) throw failure;
      const rows = database
        .prepare(`SELECT sequence, record FROM calls
        WHERE workspace_id = ? AND session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`)
        .all(workspaceId, sessionId, before ?? Number.MAX_SAFE_INTEGER, PAGE_SIZE + 1);
      const calls = rows.slice(0, PAGE_SIZE).map((row) => ({
        ...(JSON.parse(String(row.record)) as Omit<SessionMcpCall, 'sequence'>),
        sequence: Number(row.sequence),
      }));
      const count = database
        .prepare('SELECT COUNT(*) AS total FROM calls WHERE workspace_id = ? AND session_id = ?')
        .get(workspaceId, sessionId);
      return {
        calls,
        total: Number(count?.total ?? 0),
        ...(rows.length > PAGE_SIZE ? { nextBefore: calls.at(-1)!.sequence } : {}),
      };
    },
    close(): void {
      database.close();
    },
  };
}

export type SessionMcpActivityStore = ReturnType<typeof createSessionMcpActivityStore>;
