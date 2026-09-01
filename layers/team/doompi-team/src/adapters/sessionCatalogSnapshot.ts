/**
 * The catalog bridge between the agent process and the cockpit hub.
 *
 * WHY A FILE:
 * Agent discovery only answers correctly inside the Pi process. The domain
 * projection exports its agent directories into that process's environment
 * (`PI_SUBAGENT_EXTRA_AGENT_DIRS`) and its harness state carries the Team model
 * policy. The hub and the session API both run in `doompi-server`, which is the
 * grandparent of that process and never receives either, so discovery run there
 * reports an empty catalog for every domain-provided agent. The session writes
 * what it discovered into its own scope directory and the hub reads it, the same
 * one-way file bridge the runs channel already uses.
 *
 * DESIGN PATTERNS:
 * - Written by the root session only. A spawned child shares its parent's scope
 *   directory, so letting children write would let a subagent's cwd overwrite
 *   the catalog the user is looking at
 * - Read defensively: a missing, partial or foreign-cwd file is a normal state
 *   that falls back to the reader's own discovery, never an error
 * - Written atomically through a temporary file, because the reader polls
 *
 * AVOID:
 * - Storing agent system prompts here; the catalog needs the summary fields only
 * - Treating a stale snapshot as authoritative for anything but display
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CatalogAgentInput } from '../services/webSubagentCatalog.ts';
import { teamRunsDirFor } from './webSubagentWatcher.ts';

const CATALOG_FILE_NAME = 'catalog.json';
const SNAPSHOT_VERSION = 1;
const CATALOG_SOURCES = new Set(['project', 'user', 'plugin']);

/** What the session published: the agents it can launch and the models it offers. */
export interface SessionCatalogSnapshot {
  version: number;
  /** The session's working directory, so a reader can reject a stale scope. */
  cwd: string;
  agents: CatalogAgentInput[];
  models: string[];
  updatedAt: string;
}

export interface SessionCatalogPathInput {
  /** The root Pi session id, which scopes this package's temp tree. */
  sessionId: string;
  /** os.tmpdir(), supplied by the caller. */
  tmpdir: string;
  /** process.getuid(), absent on platforms without one. */
  uid: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCatalogAgent(value: unknown): value is CatalogAgentInput {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.source === 'string' &&
    CATALOG_SOURCES.has(value.source)
  );
}

/**
 * Where a session publishes its catalog.
 *
 * Derived from the runs directory rather than from `paths.ts`, so the hub keeps
 * resolving the layout from injected values instead of module-level state read
 * at import time in a different process.
 */
export function sessionCatalogPathFor(input: SessionCatalogPathInput): string | undefined {
  if (input.uid === undefined) return undefined;
  const runsDir = teamRunsDirFor(input);
  return runsDir === undefined ? undefined : path.join(path.dirname(runsDir), CATALOG_FILE_NAME);
}

/** Publish the session's catalog. Never throws: a failed publish only costs freshness. */
export function writeSessionCatalogSnapshot(
  sessionId: string,
  snapshot: Omit<SessionCatalogSnapshot, 'version' | 'updatedAt'>,
): void {
  const target = sessionCatalogPathFor({ sessionId, tmpdir: os.tmpdir(), uid: process.getuid?.() });
  if (target === undefined) return;
  const payload: SessionCatalogSnapshot = {
    ...snapshot,
    version: SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${target}.${String(process.pid)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    // The hub falls back to its own discovery; a publish is best effort.
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Nothing left to do about a temp file we cannot remove.
    }
  }
}

/** Read a session's published catalog, or undefined when there is no usable one. */
export function readSessionCatalogSnapshot(input: SessionCatalogPathInput): SessionCatalogSnapshot | undefined {
  const target = sessionCatalogPathFor(input);
  if (target === undefined) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return undefined; // Written by the session on its first turn; absent before that.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== SNAPSHOT_VERSION ||
    typeof parsed.cwd !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    !Array.isArray(parsed.agents) ||
    !parsed.agents.every(isCatalogAgent) ||
    !Array.isArray(parsed.models)
  ) {
    return undefined;
  }
  return {
    version: SNAPSHOT_VERSION,
    cwd: parsed.cwd,
    agents: parsed.agents,
    models: parsed.models.filter((model): model is string => typeof model === 'string'),
    updatedAt: parsed.updatedAt,
  };
}
