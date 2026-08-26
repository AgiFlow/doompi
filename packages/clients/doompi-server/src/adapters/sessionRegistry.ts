import fs from 'node:fs';
import { sessionRecordPath, sessionRecordsDir } from '../services/registryPaths.ts';
import type { SessionRecord } from '../types/registry.ts';

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const TMP_SUFFIX = '.tmp';

/**
 * Publishes one session record in the registry directory.
 *
 * The write is atomic (tmp then rename) so a reader never sees a half-written
 * record, and everything is owner-only because the record points at the token
 * file. A restart with the same session id simply overwrites its record.
 */
export function writeSessionRecord(registryDir: string, record: SessionRecord): void {
  fs.mkdirSync(sessionRecordsDir(registryDir), { recursive: true, mode: OWNER_ONLY_DIR });
  const target = sessionRecordPath(registryDir, record.id);
  const temporary = `${target}${TMP_SUFFIX}`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: OWNER_ONLY_FILE });
  fs.renameSync(temporary, target);
}

/** Withdraws a session record; missing files are fine (a janitor may have won). */
export function removeSessionRecord(registryDir: string, sessionId: string): void {
  fs.rmSync(sessionRecordPath(registryDir, sessionId), { force: true });
}
