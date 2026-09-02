import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContextDetailFile, ContextItemDetail, ContextItemKind } from '../types/contextApi.ts';
import { CONTEXT_DETAIL_VERSION } from '../types/contextApi.ts';

/**
 * Where the agent leaves the composition's detail for the session API to find.
 *
 * The two are separate processes: the inventory only exists inside the agent,
 * and the API that answers the browser is served by the session's host. Every
 * other package-owned API in the repository bridges that gap through the
 * filesystem rather than through the frame protocol, and this one follows,
 * because a file is also what makes the answer survive the agent going quiet
 * between turns.
 *
 * One file per session, replaced whole. The detail is a projection of the
 * composition, not a log of it, so an older copy has no reader.
 */

const DIRECTORY_NAME = 'doom-context';
const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
/** Owner-only: a tool schema is not secret, but it describes the machine. */
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function agentDirectory(environment: NodeJS.ProcessEnv): string {
  return environment[AGENT_DIR_ENV] || path.join(os.homedir(), '.pi', 'agent');
}

/** A session id reaches this from a query string, so it never becomes a path. */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/gu, '_');
}

export function contextDetailPath(sessionId: string, environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDirectory(environment), DIRECTORY_NAME, `${safeName(sessionId)}.json`);
}

/**
 * Publishes the detail for one session.
 *
 * Written through a temporary file so a reader never sees half a document, and
 * failures are reported to the caller rather than thrown: the panel works
 * without this, and a session must not be lost to a full disk.
 */
export function writeContextDetail(
  sessionId: string,
  revision: number,
  items: readonly ContextItemDetail[],
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = contextDetailPath(sessionId, environment);
  const payload: ContextDetailFile = { version: CONTEXT_DETAIL_VERSION, revision, items };
  const temporary = `${target}.${String(process.pid)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.writeFileSync(temporary, JSON.stringify(payload), { mode: PRIVATE_FILE_MODE });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The temporary file is already unreachable; nothing further to do.
    }
    return false;
  }
}

/** Drops a session's file. Called when the session ends, so the directory does not grow forever. */
export function removeContextDetail(sessionId: string, environment: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.rmSync(contextDetailPath(sessionId, environment), { force: true });
  } catch {
    // A file that cannot be removed is stale, not fatal; the next session with
    // this id overwrites it.
  }
}

function isDetailFile(value: unknown): value is ContextDetailFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === CONTEXT_DETAIL_VERSION && Array.isArray(candidate.items);
}

/** What the session wrote, or undefined when it has not written yet. */
export function readContextDetail(
  sessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): ContextDetailFile | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(contextDetailPath(sessionId, environment), 'utf8'));
    return isDetailFile(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One row's detail, matched the way the panel identifies it. */
export function findContextItem(
  file: ContextDetailFile,
  itemKind: ContextItemKind,
  name: string,
): ContextItemDetail | undefined {
  return file.items.find((item) => item.itemKind === itemKind && item.name === name);
}
