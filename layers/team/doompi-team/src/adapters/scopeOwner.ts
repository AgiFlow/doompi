/**
 * Who owns a session scope, recorded on disk so a later sweep can tell an
 * abandoned tree from a live one.
 *
 * WHY A FILE AND NOT AN IN-MEMORY REGISTRY:
 * The process that owns a scope is exactly the process that cannot report on
 * it once it is gone. A crashed session leaves its whole tree behind, and the
 * only thing able to reclaim that is a different process reading something the
 * dead one left written down.
 *
 * WHY LIVENESS IS NOT DECIDED HERE:
 * This module records `hostPid` and reads it back; it does not decide whether a
 * scope is reapable. That rule needs run liveness too - after `/new` the
 * abandoned scope's `hostPid` is the still-live current process, so a
 * hostPid-only test would never reap it - and it belongs with the run registry
 * that knows about runs.
 *
 * AVOID:
 * - Treating a missing or unreadable owner file as "safe to delete". An
 *   unreadable owner is unknown, not dead
 */

import * as fs from 'node:fs';

import { type SessionScope, scopeOwnerPath } from './filesystem/paths';
import { parseVersioned } from '../services/support/versioned';
import { writeAtomicJson, writeAtomicJsonAsync } from './atomicJson';

const SCOPE_OWNER_VERSION = 1;

export interface ScopeOwnerRecord {
  version: typeof SCOPE_OWNER_VERSION;
  rootSessionId: string;
  /** The process that adopted this scope. Dead pid plus no live runs means reapable. */
  hostPid: number;
  startedAt: number;
}

/**
 * Claim a scope for this process.
 *
 * Rewritten rather than written once: `/resume` reopens the same session id,
 * so the same scope is legitimately re-adopted by a later process, and the
 * record has to name the process that owns it now rather than the one that
 * first created the directory.
 */
function scopeOwnerRecord(scope: SessionScope, now: number): ScopeOwnerRecord {
  return {
    version: SCOPE_OWNER_VERSION,
    rootSessionId: scope.rootSessionId,
    hostPid: process.pid,
    startedAt: now,
  };
}

export function writeScopeOwner(scope: SessionScope, now: number = Date.now()): ScopeOwnerRecord {
  const record = scopeOwnerRecord(scope, now);
  writeAtomicJson(scopeOwnerPath(scope), record);
  return record;
}

export async function writeScopeOwnerAsync(scope: SessionScope, now: number = Date.now()): Promise<ScopeOwnerRecord> {
  const record = scopeOwnerRecord(scope, now);
  await writeAtomicJsonAsync(scopeOwnerPath(scope), record);
  return record;
}

/** `undefined` when the scope has no readable owner: unknown, which is not the same as dead. */
function parseScopeOwner(raw: string): ScopeOwnerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = parseVersioned<ScopeOwnerRecord>(parsed, [SCOPE_OWNER_VERSION]);
  if (!result.ok) return undefined;
  const record = result.value;
  if (typeof record.rootSessionId !== 'string' || !record.rootSessionId) return undefined;
  if (!Number.isInteger(record.hostPid)) return undefined;
  return record;
}

export function readScopeOwner(scope: SessionScope): ScopeOwnerRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(scopeOwnerPath(scope), 'utf-8');
  } catch {
    // Absent or unreadable. Both mean "cannot say who owns this", and the
    // caller must treat that as unknown rather than unowned.
    return undefined;
  }

  return parseScopeOwner(raw);
}

export async function readScopeOwnerAsync(scope: SessionScope): Promise<ScopeOwnerRecord | undefined> {
  try {
    return parseScopeOwner(await fs.promises.readFile(scopeOwnerPath(scope), 'utf-8'));
  } catch {
    return undefined;
  }
}
