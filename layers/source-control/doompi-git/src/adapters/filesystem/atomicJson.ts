import fs from 'node:fs';
import path from 'node:path';

const OWNER_ONLY_FILE = 0o600;

/**
 * Writes JSON so a reader never sees a half-written file.
 *
 * The registry is read by the same process that writes it, and by a later
 * process after a crash. A plain write can be interrupted between the truncate
 * and the last byte, which leaves a file that parses as nothing and loses every
 * record in it. Writing beside the target and renaming makes the swap atomic on
 * the same filesystem, so a reader sees either the old file or the new one.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${String(process.pid)}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: OWNER_ONLY_FILE });
  fs.renameSync(temporary, file);
}

/**
 * Reads JSON, treating every failure as absent.
 *
 * A missing file and an unparseable one mean the same thing to every caller
 * here: there is nothing to act on. Distinguishing them would only offer a
 * choice no caller wants to make.
 */
export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
