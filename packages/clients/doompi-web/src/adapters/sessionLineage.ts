import fs from 'node:fs';
import path from 'node:path';
import { parseSessionLineage, sessionLineagePath } from '@agimon-ai/doompi-web-contracts';
import type { SessionLineageRecord } from '@agimon-ai/doompi-web-contracts';
import type { SessionLineage } from '../types/hub.ts';

/**
 * Reads the lineage sidecar a spawning package wrote beside a session's record.
 *
 * Best effort in exactly the way readGitStatus is: a missing file, an
 * unreadable one, and a half-written one all mean the same thing to the rail,
 * which is that this session has no known parent and renders at the top level.
 * The sidecar exists because the session record's own schema belongs to the
 * session server, so a package that spawns a session cannot add a field to it.
 */
export function readSessionLineage(registryDir: string, sessionId: string): SessionLineage | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionLineagePath(registryDir, sessionId), 'utf8');
  } catch {
    return undefined;
  }
  const record = parseSessionLineage(raw);
  if (record === undefined) return undefined;
  return { parentSessionId: record.parentSessionId, provenance: record.provenance };
}

/**
 * Records where a session came from, beside the record the server will write.
 *
 * The hub is the only party that can do this. It mints the session id, so a
 * package asking for a session has nothing to key a sidecar on until the hub
 * answers, and by then the session has already registered and been read.
 *
 * Write failures are swallowed for the same reason reads are: lineage decides
 * how a row is drawn, not whether the session works. A session that starts and
 * renders at the top level is a far better outcome than a refused create.
 */
export function writeSessionLineage(registryDir: string, sessionId: string, record: SessionLineageRecord): void {
  const file = sessionLineagePath(registryDir, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Temp-then-rename so the hub's reader cannot catch a partial record; it
    // reads once and would cache the failure for the session's whole life.
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // The session still starts; it just renders unnested.
  }
}
